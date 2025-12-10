'use strict';
/**
 * index.js - Cloud Functions v2 (complete)
 *
 * Funcionalidad:
 * - Firestore onCreate trigger: asigna nueva orden a vendedor activo (round-robin)
 * - RTDB presence onWrite trigger: al conectarse un vendedor intenta reasignar pendientes
 * - HTTP endpoint protegido: reassignPendingOrdersHttp para forzar reasignación/manual + uso con Cloud Scheduler
 * - processPendingOrders: busca órdenes pendientes en Firestore y RTDB y las asigna
 * - assignOrderToNextVendor: rota (transaction) sobre assignmentMeta/lastAssignedSellerUid y escribe:
 *     - assignedSeller (UID), assignedSellerName, assignedSellerEmail, assignedAt, status
 *   NO sobreescribe asignación si la orden ya tiene assignedSeller en RTDB o Firestore.
 *
 * Requisitos / notas:
 * - Usa firebase-functions v2 triggers (v2 Firestore / v2 Database / v2 https)
 * - Las Cloud Functions con Admin SDK ignoran las reglas de seguridad (por diseño)
 * - Protecciones añadidas:
 *    * La función no sobrescribe assignedSeller si ya existe
 *    * Frontend debe respetar locking (recomendado, pero no imprescindible si funciones protegen)
 *
 * Despliegue:
 * - Desde carpeta functions: npm install (si es necesario) && firebase deploy --only functions
 * - Asegúrate APIs habilitadas y Eventarc service agent role si hubo errores de despliegue previos.
 */

const functionsV2 = require('firebase-functions');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onRequest } = require('firebase-functions/v2/https');
const { onValueWritten } = require('firebase-functions/v2/database');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

admin.initializeApp();

const dbRT = admin.database();
const firestore = admin.firestore();

/* ============================
   Helpers
   ============================ */

/**
 * getActiveVendorUids
 * - Lee /presence en RTDB (keys truthy)
 * - Valida que exista users/{uid} en Firestore con role == 'vendedor'
 * - Retorna array de UIDs activos (orden determinista según keys)
 */
async function getActiveVendorUids() {
  try {
    const presSnap = await dbRT.ref('presence').once('value');
    const presObj = presSnap.val() || {};
    const presenceKeys = Object.keys(presObj || {}).filter(k => !!presObj[k]);

    logger.debug('getActiveVendorUids: presenceKeys', { presenceKeys });

    if (!presenceKeys.length) return [];

    const active = [];
    await Promise.all(presenceKeys.map(async (uid) => {
      try {
        const userDoc = await firestore.doc(`users/${uid}`).get();
        if (!userDoc.exists) {
          logger.debug(`getActiveVendorUids: users/${uid} doc not found`);
          return;
        }
        const ud = userDoc.data() || {};
        const role = (ud.role || '').toString().toLowerCase();
        const status = (ud.status || '').toString().toLowerCase();
        if (role === 'vendedor' && status !== 'inactivo' && status !== 'suspended') {
          active.push(uid);
        } else {
          logger.debug(`getActiveVendorUids: users/${uid} skipped (role/status)`, { role, status });
        }
      } catch (e) {
        logger.warn(`getActiveVendorUids: error reading users/${uid}`, e);
      }
    }));

    logger.info('getActiveVendorUids resolved', { active });
    return active;
  } catch (err) {
    logger.error('getActiveVendorUids fatal error', err);
    return [];
  }
}

/* ============================
   Core: asignación round-robin
   ============================ */

/**
 * assignOrderToNextVendor
 * - No sobrescribe si orden ya tiene assignedSeller (RTDB o Firestore)
 * - Usa transaction en assignmentMeta/lastAssignedSellerUid para rotar
 * - Escribe assignedSeller, assignedSellerName, assignedSellerEmail, assignedAt y status
 * - orderSource: string (ej: 'oncreate-fs', 'auto-rr', 'rtdb')
 */
async function assignOrderToNextVendor(orderId, activeUids, orderSource = 'auto') {
  if (!Array.isArray(activeUids) || !activeUids.length) {
    logger.info(`assignOrderToNextVendor: no active vendors for order ${orderId}`);
    return false;
  }

  try {
    // --- 0) Verificar si ya existe asignación (RTDB preferente)
    try {
      const rtdbAssignedSnap = await dbRT.ref(`orders/${orderId}/assignedSeller`).once('value');
      const rtdbAssigned = rtdbAssignedSnap.exists() ? rtdbAssignedSnap.val() : null;
      if (rtdbAssigned) {
        logger.info(`assignOrderToNextVendor: order ${orderId} already assigned in RTDB to ${rtdbAssigned} - not overwriting`);
        return false;
      }
    } catch (e) {
      logger.debug('assignOrderToNextVendor: RTDB check failed (continuing)', e);
    }

    try {
      const fsSnap = await firestore.doc(`orders/${orderId}`).get();
      if (fsSnap.exists) {
        const data = fsSnap.data() || {};
        if (data.assignedSeller) {
          logger.info(`assignOrderToNextVendor: order ${orderId} already assigned in Firestore to ${data.assignedSeller} - not overwriting`);
          return false;
        }
      }
    } catch (e) {
      logger.debug('assignOrderToNextVendor: Firestore check failed (continuing)', e);
    }

    // --- 1) Transaction sobre assignmentMeta/lastAssignedSellerUid
    const assignmentRef = dbRT.ref('assignmentMeta/lastAssignedSellerUid');
    const trRes = await assignmentRef.transaction((current) => {
      if (!current || activeUids.indexOf(current) === -1) return activeUids[0];
      const idx = activeUids.indexOf(current);
      return activeUids[(idx + 1) % activeUids.length];
    });

    const assignedUid = trRes && trRes.snapshot ? trRes.snapshot.val() : null;
    const finalAssigned = assignedUid || activeUids[0];

    // --- 2) Obtener datos del vendedor desde Firestore (name/email) si están disponibles
    let sellerName = '';
    let sellerEmail = '';
    try {
      const sellerDoc = await firestore.doc(`users/${finalAssigned}`).get();
      if (sellerDoc.exists) {
        const sd = sellerDoc.data() || {};
        sellerName = sd.name || sd.displayName || sd.email || '';
        sellerEmail = sd.email || '';
      }
    } catch (e) {
      logger.warn(`assignOrderToNextVendor: reading users/${finalAssigned} failed`, e);
    }

    // Timestamps
    const timestampRT = admin.database.ServerValue.TIMESTAMP;
    const timestampFS = admin.firestore.FieldValue.serverTimestamp();

    // --- 3) Escribir en RTDB y Firestore (update/merge)
    const updatesRT = {
      assignedSeller: finalAssigned,
      assignedSellerName: sellerName || null,
      assignedSellerEmail: sellerEmail || null,
      assignedAt: timestampRT,
      status: 'assigned'
    };

    const updatesFS = {
      assignedSeller: finalAssigned,
      assignedSellerName: sellerName || null,
      assignedSellerEmail: sellerEmail || null,
      assignedAt: timestampFS,
      status: 'asignado',
      assignmentSource: orderSource
    };

    await Promise.all([
      dbRT.ref(`orders/${orderId}`).update(updatesRT).catch(err => logger.debug(`RTDB update orders/${orderId} failed`, err)),
      dbRT.ref(`sellerAssignments/${finalAssigned}`).push({
        orderId,
        assignedAt: timestampRT,
        source: orderSource,
        assignedSellerName: sellerName || null
      }).catch(err => logger.debug(`RTDB push sellerAssignments/${finalAssigned} failed`, err)),
      firestore.doc(`orders/${orderId}`).set(updatesFS, { merge: true }).catch(err => logger.debug(`Firestore set orders/${orderId} failed`, err))
    ]);

    logger.info(`Order ${orderId} assigned to seller ${finalAssigned} (${sellerName || 'no-name'})`);
    return true;
  } catch (err) {
    logger.error(`assignOrderToNextVendor error for ${orderId}:`, err);
    try {
      await firestore.doc(`orders/${orderId}`).set({
        assignmentError: String(err),
        assignmentAttemptedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (e) {
      logger.warn('assignOrderToNextVendor: could not write assignmentError to Firestore', e);
    }
    return false;
  }
}

/* ============================
   Buscar y reasignar pendientes
   ============================ */

/**
 * processPendingOrders
 * - Busca órdenes "pendientes" en Firestore (varias variantes de status)
 * - Escanea RTDB/orders para capturar órdenes sin assignedSeller
 * - Si hay vendedores activos, asigna cada orden por round-robin
 */
async function processPendingOrders(limit = 500) {
  logger.info('processPendingOrders: start');
  const pendingIds = new Set();

  // Firestore: buscar variantes comunes de status
  const variants = ['pendiente', 'pendiente_asignacion', 'pending', 'Pendiente', 'Pending'];
  try {
    for (const v of variants) {
      try {
        const q = await firestore.collection('orders').where('status', '==', v).limit(limit).get();
        q.forEach(doc => {
          const d = doc.data() || {};
          if (!d.assignedSeller) pendingIds.add(doc.id);
        });
      } catch (e) {
        logger.debug(`processPendingOrders: Firestore query status='${v}' failed`, e);
      }
    }

    // También intentar assignedSeller == null (si el campo existe)
    try {
      const q2 = await firestore.collection('orders').where('assignedSeller', '==', null).limit(limit).get();
      q2.forEach(doc => pendingIds.add(doc.id));
    } catch (e) {
      logger.debug('processPendingOrders: Firestore query assignedSeller==null failed (non-fatal)', e);
    }
  } catch (e) {
    logger.warn('processPendingOrders: Firestore stage had an error', e);
  }

  // RTDB scan: leer primeras 'limit' entradas y agregar las que no tengan assignedSeller o status pendiente
  try {
    const snap = await dbRT.ref('orders').limitToFirst(limit).once('value');
    const obj = snap.val() || {};
    Object.entries(obj).forEach(([key, val]) => {
      if (!val) return;
      const hasAssigned = (typeof val.assignedSeller !== 'undefined' && val.assignedSeller !== null && val.assignedSeller !== '');
      const status = (val.status || '').toString().toLowerCase();
      if (!hasAssigned || status.includes('pendient') || status.includes('pending')) {
        pendingIds.add(key);
      }
    });
    logger.info('processPendingOrders: RTDB scan added candidates', { total: pendingIds.size });
  } catch (e) {
    logger.warn('processPendingOrders: RTDB scan failed', e);
  }

  if (!pendingIds.size) {
    logger.info('processPendingOrders: no pending orders found');
    return { processed: 0, found: 0 };
  }

  // Obtener vendedores activos
  const activeUids = await getActiveVendorUids();
  if (!activeUids.length) {
    logger.info('processPendingOrders: no active vendors - aborting reassignment');
    return { processed: 0, found: pendingIds.size, reason: 'no_active_vendors' };
  }

  let processed = 0;
  for (const orderId of Array.from(pendingIds)) {
    try {
      const ok = await assignOrderToNextVendor(orderId, activeUids, 'auto-rr');
      if (ok) processed++;
    } catch (e) {
      logger.warn(`processPendingOrders: error assigning ${orderId}`, e);
    }
  }

  logger.info(`processPendingOrders done: processed=${processed}, found=${pendingIds.size}`);
  return { processed, found: pendingIds.size };
}

/* ============================
   Triggers
   ============================ */

/**
 * Firestore onCreate trigger (v2)
 * - Se dispara cuando se crea orders/{orderId} en Firestore
 * - Intenta asignar inmediatamente; si no hay vendedores activos marca pendiente
 */
exports.assignOrderToSeller = onDocumentCreated('orders/{orderId}', async (event) => {
  const orderId = event.params?.orderId;
  logger.info('assignOrderToSeller trigger fired', { orderId });

  try {
    const activeUids = await getActiveVendorUids();
    logger.debug('assignOrderToSeller: activeUids', { activeUids });

    if (!activeUids.length) {
      // marcar pendiente en Firestore y RTDB (no sobrescribir assignedSeller)
      await firestore.doc(`orders/${orderId}`).set({
        assignedSeller: null,
        assignedAt: null,
        status: 'pendiente'
      }, { merge: true }).catch(e => logger.debug('assignOrderToSeller: Firestore set pending failed', e));

      await dbRT.ref(`orders/${orderId}`).update({
        assignedSeller: null,
        assignedAt: null,
        status: 'pendiente'
      }).catch(e => logger.debug('assignOrderToSeller: RTDB update pending failed', e));

      logger.info(`assignOrderToSeller: order ${orderId} left pending (no active vendors)`);
      return;
    }

    // Intentar asignar (la función evitará sobrescribir si ya asignada)
    const ok = await assignOrderToNextVendor(orderId, activeUids, 'oncreate-fs');
    if (!ok) logger.debug('assignOrderToSeller: assignOrderToNextVendor returned false (maybe already assigned)');
    return;
  } catch (err) {
    logger.error('assignOrderToSeller error', err);
    try {
      await firestore.doc(`orders/${orderId}`).set({
        assignmentError: String(err),
        assignmentAttemptedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (e) { logger.warn('assignOrderToSeller: could not write assignmentError', e); }
    return;
  }
});

/**
 * RTDB presence onWrite trigger (v2)
 * - Cuando /presence/{uid} cambia a online (transición false->true), intenta reasignar pendientes
 */
exports.onPresenceChanged = onValueWritten('/presence/{uid}', async (event) => {
  try {
    const beforeVal = event.data && event.data.before ? event.data.before.val() : null;
    const afterVal = event.data && event.data.after ? event.data.after.val() : null;
    const uid = event.params?.uid;

    logger.debug('onPresenceChanged event', { uid, beforeVal, afterVal });

    const becameOnline = (!!afterVal && ((afterVal.state && afterVal.state.toString().toLowerCase() === 'online') || afterVal === true || typeof afterVal === 'object'));
    const wasOnline = (!!beforeVal && ((beforeVal.state && beforeVal.state.toString().toLowerCase() === 'online') || beforeVal === true));

    if (!becameOnline || wasOnline) {
      logger.debug('onPresenceChanged: not a transition offline->online, ignoring', { uid, becameOnline, wasOnline });
      return;
    }

    logger.info(`onPresenceChanged: vendor ${uid} came online — attempting reassign pending orders`);
    const res = await processPendingOrders(500);
    logger.info('onPresenceChanged processPendingOrders result', { res });
    return;
  } catch (e) {
    logger.error('onPresenceChanged error', e);
    return;
  }
});

/**
 * HTTP trigger (v2) para forzar reasignación manual (protegido por secret)
 * - Protege con functions config scheduler.secret o env SCHEDULER_SECRET
 */
exports.reassignPendingOrdersHttp = onRequest(async (req, res) => {
  const cfgSecret = (functionsV2.config && functionsV2.config().scheduler && functionsV2.config().scheduler.secret) || process.env.SCHEDULER_SECRET || '';
  const provided = req.get('x-scheduler-secret') || req.query.secret || '';

  if (cfgSecret && provided !== cfgSecret) {
    logger.warn('reassignPendingOrdersHttp unauthorized call (bad secret)');
    return res.status(401).send('Unauthorized');
  }

  try {
    const result = await processPendingOrders(1000);
    return res.status(200).json({ ok: true, result });
  } catch (e) {
    logger.error('reassignPendingOrdersHttp error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

/* ============================
   Optional: Export helpers for testing (no-op)
   ============================ */
exports._internal = {
  getActiveVendorUids,
  assignOrderToNextVendor,
  processPendingOrders
};