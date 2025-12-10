// assets/js/orders-admin.js
// Página de administración de pedidos (mejorada): modal de detalle con miniaturas resueltas desde Storage,
// imágenes cached, cartilla detallada de items (cantidad, precio unitario, subtotal), y control por roles.
//
// Esta versión adaptada renderiza la misma tabla, columnas y botones que orders.js/orders.html
// (Asignar, Ver, Marcar pagado/enviado/entregado, WhatsApp) para que la página de administrador muestre
// exactamente la misma información y acciones que la vista de pedidos estándar, manteniendo los KPIs y
// acciones rápidas intactas.
//
// Cambios recientes: en la UI de administración se ignoran las restricciones de visibilidad/desactivación
// que aplicaban a vendedores/motorizados — es decir, cuando el usuario es administrador los botones estarán
// disponibles (y ejecutables) independientemente de si el pedido está "fully assigned". Las comprobaciones
// de permisos en las funciones que actualizan documentos siguen permitiendo sólo a administradores realizar
// acciones especiales (además de los vendedores/motorizados cuando corresponda).

import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  getDocs,
  getDoc,
  updateDoc,
  addDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";
import {
  getStorage,
  ref as storageRef,
  uploadBytes,
  getDownloadURL
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-storage.js";

// Initialize Firebase app
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

/* ---------------- UI elements (support both variants of admin page) ---------------- */
const ordersBody = document.getElementById('ordersBody') || document.getElementById('ordersTbody') || document.getElementById('ordersTbodyAdmin') || null;
const pageInfo = document.getElementById('pageInfo');
const prevPageBtn = document.getElementById('prevPage');
const nextPageBtn = document.getElementById('nextPage');
const perPageSelect = document.getElementById('perPageSelect');
const searchInput = document.getElementById('searchInput') || document.getElementById('q') || document.getElementById('q-admin');
const paymentFilter = document.getElementById('paymentFilter') || document.getElementById('estadoPago');
const shippingFilter = document.getElementById('shippingFilter') || document.getElementById('estadoEnvio');
const sellerFilter = document.getElementById('sellerFilter');
const motorFilter = document.getElementById('motorFilter') || document.getElementById('motorizadoFiltro');
const dateFrom = document.getElementById('dateFrom') || document.getElementById('fechaInicio');
const dateTo = document.getElementById('dateTo') || document.getElementById('fechaFin');
const applyFiltersBtn = document.getElementById('applyFilters');
const clearFiltersBtn = document.getElementById('clearFilters') || document.getElementById('resetFilters');
const refreshBtn = document.getElementById('refreshBtn');
const downloadCsvBtn = document.getElementById('downloadCsv') || document.getElementById('downloadCsvAdmin');

const orderModal = document.getElementById('orderModal');
const orderModalTitle = document.getElementById('orderModalTitle');
const closeOrderModalBtn = document.getElementById('closeOrderModal');
const orderDetailsEl = document.getElementById('orderDetails');
const assignSection = document.getElementById('assignSection');
const assignSellerSelect = document.getElementById('assignSellerSelect');
const assignMotorSelect = document.getElementById('assignMotorSelect');
const saveAssignBtn = document.getElementById('saveAssignBtn');
const confirmDeliveryForm = document.getElementById('confirmDeliveryForm');
const deliveryPaymentMethod = document.getElementById('deliveryPaymentMethod');
const deliveryObs = document.getElementById('deliveryObs');
const deliveryProof = document.getElementById('deliveryProof');
const confirmDeliveryBtn = document.getElementById('confirmDeliveryBtn');

const assignModal = document.getElementById('assignModal');
const assignClose = document.getElementById('assignModalClose');
const assignCancel = document.getElementById('assignCancel');
const assignConfirm = document.getElementById('assignConfirm');
const vendedoresTableBody = document.querySelector('#vendedoresList tbody');
const motorizadosTableBody = document.querySelector('#motorizadosList tbody');

const viewModal = document.getElementById('viewModal');
const viewClose = document.getElementById('viewModalClose');
const viewCloseBtn = document.getElementById('viewCloseBtn');
const orderTimeline = document.getElementById('orderTimeline');

const toastEl = document.getElementById('toast');

/* ---------------- State ---------------- */
let currentUser = null;
let currentUserRole = null;
let unsubscribeOrders = null;
let ordersCache = []; // filtered set stored client-side
let currentPage = 1;
let currentViewedOrder = null;
let activeVendedores = [];
let activeMotorizados = [];
let assignTargetOrderId = null;
let orderDocUnsubscribe = null;

/* ---------------- Helpers ---------------- */
function showToast(msg, timeout = 3500, isError = false) {
  if (!toastEl) {
    console.log((isError ? 'ERROR: ' : '') + msg);
    return;
  }
  toastEl.textContent = msg;
  toastEl.style.background = isError ? '#b91c1c' : '#111827';
  toastEl.classList.remove('hidden');
  toastEl.classList.add('show');
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => {
    toastEl.classList.remove('show');
    toastEl.classList.add('hidden');
  }, timeout);
}

function escapeHtml(str) {
  if (!str && str !== 0) return '';
  return String(str).replace(/[&<>"'`=\/]/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '/': '&#x2F;', '=': '&#x3D;', '`': '&#x60;' }[s]));
}

function formatCurrency(amount, currency = 'USD') {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch (e) {
    return `${amount} ${currency}`;
  }
}

function formatDate(ts) {
  if (!ts) return '-';
  try {
    if (ts?.toDate) ts = ts.toDate();
    return new Date(ts).toLocaleString();
  } catch (e) {
    return String(ts);
  }
}

function capitalize(str) {
  if (!str) return '';
  return String(str).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/* ---------------- Image resolution caches & helpers ---------------- */
const urlCache = new Map(); // storagePath or gs:// -> downloadURL
const productImagesCache = new Map(); // productId -> [urls]

async function fetchProductImages(productId) {
  if (!productId) return [];
  if (productImagesCache.has(productId)) return productImagesCache.get(productId);
  try {
    const pSnap = await getDoc(doc(db, 'product', productId));
    if (!pSnap.exists()) {
      productImagesCache.set(productId, []);
      return [];
    }
    const pdata = pSnap.data();
    if (Array.isArray(pdata.imageUrls) && pdata.imageUrls.length) {
      productImagesCache.set(productId, pdata.imageUrls.slice());
      return pdata.imageUrls.slice();
    }
    const pathCandidates = Array.isArray(pdata.imagePaths) && pdata.imagePaths.length ? pdata.imagePaths.slice() : (pdata.imagePath ? [pdata.imagePath] : []);
    if (pathCandidates.length) {
      const resolved = await Promise.all(pathCandidates.map(async p => {
        try {
          if (!p) return '';
          if (urlCache.has(p)) return urlCache.get(p);
          const ref = storageRef(storage, p.startsWith('/') ? p.slice(1) : p);
          const durl = await getDownloadURL(ref);
          urlCache.set(p, durl);
          return durl;
        } catch (e) {
          console.warn('fetchProductImages: no se pudo resolver path', p, e);
          return '';
        }
      }));
      const filtered = resolved.filter(Boolean);
      productImagesCache.set(productId, filtered);
      return filtered;
    }
    if (pdata.imageUrl) {
      productImagesCache.set(productId, [pdata.imageUrl]);
      return [pdata.imageUrl];
    }
    productImagesCache.set(productId, []);
    return [];
  } catch (err) {
    console.error('fetchProductImages error', err);
    productImagesCache.set(productId, []);
    return [];
  }
}

async function resolveImageUrl(imgRefOrUrl, productId) {
  try {
    if (imgRefOrUrl && /^https?:\/\//i.test(imgRefOrUrl)) return imgRefOrUrl;
    const v = (imgRefOrUrl || '').toString().trim();
    if (!v && productId) {
      const pimgs = await fetchProductImages(productId);
      return pimgs[0] || '';
    }
    if (!v) return '';
    if (/^gs:\/\//i.test(v)) {
      const path = v.replace(/^gs:\/\/[^\/]+\//i, '');
      if (!path) return '';
      if (urlCache.has(v)) return urlCache.get(v);
      try {
        const ref = storageRef(storage, path);
        const durl = await getDownloadURL(ref);
        urlCache.set(v, durl);
        return durl;
      } catch (e) {
        console.warn('resolveImageUrl gs:// failed', v, e);
        if (productId) {
          const pimgs = await fetchProductImages(productId);
          return pimgs[0] || '';
        }
        return '';
      }
    }
    let pathCandidate = v;
    if (pathCandidate.startsWith('/')) pathCandidate = pathCandidate.slice(1);
    const looksLikePath = /products\//i.test(pathCandidate) || /\.[a-zA-Z0-9]{2,5}$/.test(pathCandidate);
    if (looksLikePath) {
      if (urlCache.has(pathCandidate)) return urlCache.get(pathCandidate);
      try {
        const ref = storageRef(storage, pathCandidate);
        const durl = await getDownloadURL(ref);
        urlCache.set(pathCandidate, durl);
        return durl;
      } catch (e) {
        console.warn('resolveImageUrl path failed', pathCandidate, e);
        if (productId) {
          const pimgs = await fetchProductImages(productId);
          return pimgs[0] || '';
        }
        return '';
      }
    }
    if (productId) {
      const pimgs = await fetchProductImages(productId);
      const match = pimgs.find(u => u.endsWith(pathCandidate) || u.includes(pathCandidate));
      if (match) return match;
      return pimgs[0] || '';
    }
    return '';
  } catch (err) {
    console.error('resolveImageUrl unexpected error', err);
    return '';
  }
}

/* ---------------- Populate user selects and active users ---------------- */
async function populateUserSelectors() {
  if (assignSellerSelect) assignSellerSelect.innerHTML = '<option value="">-- seleccionar --</option>';
  if (assignMotorSelect) assignMotorSelect.innerHTML = '<option value="">-- seleccionar --</option>';
  if (sellerFilter) sellerFilter.innerHTML = '<option value="">Todos</option>';
  if (motorFilter) motorFilter.innerHTML = '<option value="">Todos</option>';

  try {
    const usersCol = collection(db, 'users');
    const usersSnap = await getDocs(usersCol);
    activeVendedores = [];
    activeMotorizados = [];
    usersSnap.forEach(snap => {
      const u = { id: snap.id, ...snap.data() };
      if (u.role === 'vendedor') {
        activeVendedores.push(u);
        const opt = document.createElement('option');
        opt.value = u.id;
        opt.textContent = u.email || u.name || u.id;
        if (assignSellerSelect) assignSellerSelect.appendChild(opt);
        if (sellerFilter) sellerFilter.appendChild(opt.cloneNode(true));
      }
      if (u.role === 'motorizado') {
        activeMotorizados.push(u);
        const opt = document.createElement('option');
        opt.value = u.id;
        opt.textContent = u.email || u.name || u.id;
        if (assignMotorSelect) assignMotorSelect.appendChild(opt);
        if (motorFilter) motorFilter.appendChild(opt.cloneNode(true));
      }
    });
  } catch (err) {
    console.error('Error cargando usuarios:', err);
  }
}

/* ---------------- Build Firestore query by role & filters ---------------- */
function buildOrdersQuery() {
  const ordersCol = collection(db, 'orders');

  // Admin: optional where clauses if filters selected
  if (currentUserRole === 'administrador') {
    const clauses = [];
    if (paymentFilter && paymentFilter.value) clauses.push(where('paymentStatus', '==', paymentFilter.value));
    if (shippingFilter && shippingFilter.value) clauses.push(where('shippingStatus', '==', shippingFilter.value));
    if (sellerFilter && sellerFilter.value) clauses.push(where('assignedSeller', '==', sellerFilter.value));
    if (motorFilter && motorFilter.value) clauses.push(where('assignedMotor', '==', motorFilter.value));
    if (clauses.length) return query(ordersCol, ...clauses, orderBy('orderDate', 'desc'));
    return query(ordersCol, orderBy('orderDate', 'desc'));
  }

  // Vendedor: only assigned to them
  if (currentUserRole === 'vendedor') {
    return query(ordersCol, where('assignedSeller', '==', currentUser.uid), orderBy('orderDate', 'desc'));
  }

  // Motorizado: only assigned to them
  if (currentUserRole === 'motorizado') {
    return query(ordersCol, where('assignedMotor', '==', currentUser.uid), orderBy('orderDate', 'desc'));
  }

  // Default: admin-like
  return query(ordersCol, orderBy('orderDate', 'desc'));
}

/* ---------------- Subscribe to orders (real-time) ---------------- */
function subscribeOrders() {
  if (unsubscribeOrders) {
    unsubscribeOrders();
    unsubscribeOrders = null;
  }

  const q = buildOrdersQuery();

  unsubscribeOrders = onSnapshot(q, snapshot => {
    const items = [];
    snapshot.forEach(docSnap => items.push({ id: docSnap.id, ...docSnap.data() }));

    // client-side filters: search (id/name/phone/email) and date range
    const s = (searchInput && searchInput.value || '').trim().toLowerCase();
    const from = dateFrom && dateFrom.value ? new Date(dateFrom.value) : null;
    const to = dateTo && dateTo.value ? new Date(dateTo.value) : null;

    let filtered = items.filter(o => {
      // search
      if (s) {
        const idMatch = (o.id || '').toLowerCase().includes(s);
        const name = (o.customerData && (o.customerData.name || o.customerData.Customname || '')) || '';
        const email = (o.customerData && (o.customerData.email || '')) || '';
        const phone = (o.customerData && (o.customerData.phone || '')) || '';
        if (!(idMatch || name.toLowerCase().includes(s) || email.toLowerCase().includes(s) || phone.toLowerCase().includes(s))) return false;
      }

      // date
      if (from || to) {
        if (!o.orderDate) return false;
        const od = o.orderDate.toDate ? o.orderDate.toDate() : new Date(o.orderDate);
        if (from && od < from) return false;
        if (to && od > new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59)) return false;
      }

      return true;
    });

    ordersCache = filtered;
    currentPage = 1;
    renderPage();
  }, err => {
    console.error('Snapshot error:', err);
    showToast('Error recibiendo pedidos en tiempo real. Revisa la consola.');
  });
}

/* ---------------- Normalize order (compatible with orders.js) ---------------- */
function normalizeOrder(raw) {
  const o = { ...raw };
  o.clientName =
    (raw.customerData && (raw.customerData.Customname || raw.customerData.customName)) ||
    raw.name ||
    (raw.customer && (raw.customer.name || raw.customer.fullName)) ||
    raw.email ||
    '';

  if (Array.isArray(o.items) && o.items.length) {
    o.productTitle = o.items.map(i => i.name || i.title || i.productName).join(', ');
  } else {
    o.productTitle = o.productTitle || o.productName || '';
  }

  if (o.createdAt && o.createdAt.toDate) {
    o._createdAt = o.createdAt.toDate();
  } else if (o.orderDate) {
    try { o._createdAt = new Date(o.orderDate); } catch (e) { o._createdAt = o.orderDate; }
  } else if (o.timestamp) {
    o._createdAt = o.timestamp;
  } else {
    o._createdAt = null;
  }

  o.paymentStatus = (o.paymentStatus || o.payment || '').toString().toLowerCase() || '';
  o.shippingStatus = (o.shippingStatus || o.status || '').toString().toLowerCase() || '';

  if (Array.isArray(o.vendedorIds)) o._vendedorIds = o.vendedorIds;
  else if (o.vendedor) o._vendedorIds = [o.vendedor];
  else if (o.vendedorId) o._vendedorIds = [o.vendedorId];
  else o._vendedorIds = [];

  if (Array.isArray(o.motorizadoIds)) o._motorizadoIds = o.motorizadoIds;
  else if (o.motorizado) o._motorizadoIds = [o.motorizado];
  else if (o.motorizadoId) o._motorizadoIds = [o.motorizadoId];
  else o._motorizadoIds = [];

  return o;
}

/* ---------------- Render page (client-side pagination) - renders same columns & actions as orders.js ---------------- */
function renderPage() {
  if (!ordersBody) return;
  const perPageVal = perPageSelect ? perPageSelect.value : '10';
  const per = perPageVal === 'all' ? ordersCache.length || 1e9 : parseInt(perPageVal, 10) || 10;
  const total = ordersCache.length;
  const totalPages = Math.max(1, Math.ceil(total / per));
  if (currentPage > totalPages) currentPage = totalPages;

  const start = (currentPage - 1) * per;
  const end = start + per;
  const pageItems = ordersCache.slice(start, end);

  ordersBody.innerHTML = '';
  if (!pageItems.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 10;
    td.style.textAlign = 'center';
    td.style.padding = '18px';
    td.textContent = 'No hay pedidos que coincidan con los filtros.';
    tr.appendChild(td);
    ordersBody.appendChild(tr);
    pageInfo && (pageInfo.textContent = `0 / ${totalPages} (${total} pedidos)`);
    prevPageBtn && (prevPageBtn.disabled = true);
    nextPageBtn && (nextPageBtn.disabled = true);
    return;
  }

  pageItems.forEach(raw => {
    const o = normalizeOrder(raw);
    const tr = document.createElement('tr');

    // ID
    const tdId = document.createElement('td');
    tdId.textContent = o.id;
    tr.appendChild(tdId);

    // Cliente (similar to orders.js)
    const tdCust = document.createElement('td');
    const name = o.clientName || (o.customerData && (o.customerData.name || o.customerData.Customname)) || o.email || '';
    const email = o.customerData && (o.customerData.email || '') || '';
    const phone = o.customerData && (o.customerData.phone || o.customerData.telefono || '') || '';
    tdCust.innerHTML = `<div style="font-weight:600">${escapeHtml(name || email || '—')}</div><div style="color:#6b7280;font-size:12px">${escapeHtml(email || phone || '')}</div>`;
    tr.appendChild(tdCust);

    // Producto(s)
    const tdItems = document.createElement('td');
    tdItems.textContent = o.productTitle || '-';
    tr.appendChild(tdItems);

    // Fecha
    const tdDate = document.createElement('td');
    tdDate.textContent = formatDate(o._createdAt || o.orderDate || o.timestamp);
    tr.appendChild(tdDate);

    // Total
    const tdTotal = document.createElement('td');
    tdTotal.textContent = o.total ? formatCurrency(o.total, o.currency || 'USD') : `$${(o.total || 0).toLocaleString()}`;
    tr.appendChild(tdTotal);

    // Pago badge
    const tdPay = document.createElement('td');
    const payment = (o.paymentStatus || 'pendiente').toLowerCase();
    const paySpan = document.createElement('span');
    paySpan.className = `badge ${payment === 'pagado' || payment === 'paid' ? 'paid' : 'pending'}`;
    paySpan.textContent = (payment === 'pagado' || payment === 'paid') ? 'Pagado' : 'Pendiente';
    tdPay.appendChild(paySpan);
    tr.appendChild(tdPay);

    // Envío badge
    const tdShip = document.createElement('td');
    const shipping = (o.shippingStatus || 'pendiente').toLowerCase();
    const shipSpan = document.createElement('span');
    shipSpan.className = `badge ${shipping === 'enviado' || shipping === 'in_transit' ? 'shipped' : (shipping === 'entregado' || shipping === 'delivered' ? 'delivered' : 'pending')}`;
    shipSpan.textContent = (shipping === 'enviado' || shipping === 'in_transit') ? 'Enviado' : (shipping === 'entregado' || shipping === 'delivered') ? 'Entregado' : 'Pendiente';
    tdShip.appendChild(shipSpan);
    tr.appendChild(tdShip);

    // Vendedor(s)
    const tdSeller = document.createElement('td');
    tdSeller.innerHTML = (o._vendedorIds && o._vendedorIds.length) ? o._vendedorIds.map(id => `<span class="badge-state">${escapeHtml(id)}</span>`).join(' ') : (o.assignedSellerName || o.assignedSeller || '-');
    tr.appendChild(tdSeller);

    // Motorizado(s)
    const tdMotor = document.createElement('td');
    tdMotor.innerHTML = (o._motorizadoIds && o._motorizadoIds.length) ? o._motorizadoIds.map(id => `<span class="badge-state">${escapeHtml(id)}</span>`).join(' ') : (o.assignedMotorName || o.assignedMotor || '-');
    tr.appendChild(tdMotor);

    // Actions
    const tdActions = document.createElement('td');
    tdActions.className = 'actions';

    const isFullyAssigned = (o._vendedorIds && o._vendedorIds.length > 0) && (o._motorizadoIds && o._motorizadoIds.length > 0);
    const titleDisabled = 'Desactivado: requiere vendedor y motorizado asignados';

    const isAdmin = currentUserRole === 'administrador';

    // Assign button: for admin always visible; for others only when not fully assigned
    if (isAdmin || ((!o._vendedorIds.length) || (!o._motorizadoIds.length))) {
      const assignBtn = document.createElement('button');
      assignBtn.className = 'icon-btn open-assign';
      assignBtn.dataset.order = o.id;
      assignBtn.textContent = 'Asignar';
      tdActions.appendChild(assignBtn);
    }

    // View button
    const btnView = document.createElement('button');
    btnView.className = 'icon-btn view-btn';
    btnView.dataset.order = o.id;
    btnView.textContent = '...';
    tdActions.appendChild(btnView);

    // Mark paid: admin bypasses isFullyAssigned requirement
    const canMarkPaid = isAdmin || (isFullyAssigned && (currentUserRole === 'motorizado' || currentUserRole === 'administrador'));
    const btnMarkPaid = document.createElement('button');
    btnMarkPaid.className = 'icon-btn mark-paid';
    btnMarkPaid.dataset.order = o.id;
    btnMarkPaid.textContent = 'Marcar pagado';
    if (!canMarkPaid) { btnMarkPaid.disabled = true; btnMarkPaid.title = titleDisabled; }
    tdActions.appendChild(btnMarkPaid);

    // Mark sent: admin bypasses isFullyAssigned requirement
    const canMarkSent = isAdmin || (isFullyAssigned && (currentUserRole === 'vendedor' || currentUserRole === 'administrador'));
    const btnMarkSent = document.createElement('button');
    btnMarkSent.className = 'icon-btn mark-sent';
    btnMarkSent.dataset.order = o.id;
    btnMarkSent.textContent = 'Marcar enviado';
    if (!canMarkSent) { btnMarkSent.disabled = true; btnMarkSent.title = titleDisabled; }
    tdActions.appendChild(btnMarkSent);

    // Mark delivered: admin bypasses isFullyAssigned requirement
    const canMarkDelivered = isAdmin || (isFullyAssigned && (currentUserRole === 'motorizado' || currentUserRole === 'administrador'));
    const btnMarkDelivered = document.createElement('button');
    btnMarkDelivered.className = 'icon-btn mark-delivered';
    btnMarkDelivered.dataset.order = o.id;
    btnMarkDelivered.textContent = 'Marcar entregado';
    if (!canMarkDelivered) { btnMarkDelivered.disabled = true; btnMarkDelivered.title = titleDisabled; }
    tdActions.appendChild(btnMarkDelivered);

    // WhatsApp button (if phone available)
    const phone = (o.customerData && (o.customerData.phone || o.customerData.telefono || o.customerData.mobile)) || '';
    const btnWhats = document.createElement('button');
    btnWhats.className = 'icon-btn whatsapp-btn';
    btnWhats.dataset.order = o.id;
    btnWhats.dataset.phone = phone || '';
    btnWhats.textContent = 'WhatsApp';
    if (!phone) { btnWhats.disabled = true; btnWhats.title = 'No hay teléfono disponible'; }
    tdActions.appendChild(btnWhats);

    tr.appendChild(tdActions);
    ordersBody.appendChild(tr);
  });

  // Wire handlers (delegated or per-element)
  // Assign modal
  document.querySelectorAll('.open-assign').forEach(btn => { btn.onclick = () => openAssignModal(btn.dataset.order); });
  document.querySelectorAll('.view-btn').forEach(btn => { btn.onclick = () => openViewModal(btn.dataset.order); });
  document.querySelectorAll('.mark-paid').forEach(btn => {
    btn.onclick = async (e) => {
      if (btnIsDisabled(e.target)) return;
      await updateOrderPayment(e.target.dataset.order, 'pagado');
    }
  });
  document.querySelectorAll('.mark-sent').forEach(btn => {
    btn.onclick = async (e) => {
      if (btnIsDisabled(e.target)) return;
      await updateOrderShipping(e.target.dataset.order, 'enviado');
    }
  });
  document.querySelectorAll('.mark-delivered').forEach(btn => {
    btn.onclick = async (e) => {
      if (btnIsDisabled(e.target)) return;
      await updateOrderShipping(e.target.dataset.order, 'entregado');
    }
  });
  document.querySelectorAll('.whatsapp-btn').forEach(btn => {
    btn.onclick = async (e) => {
      if (btnIsDisabled(e.target)) return;
      const orderId = e.target.dataset.order;
      await openWhatsApp(orderId);
    };
  });

  pageInfo && (pageInfo.textContent = `${currentPage} / ${Math.max(1, Math.ceil(ordersCache.length / (perPageSelect.value === 'all' ? ordersCache.length : parseInt(perPageSelect.value, 10) || 10)))} (${ordersCache.length} pedidos)`);
  prevPageBtn && (prevPageBtn.disabled = currentPage <= 1);
  nextPageBtn && (nextPageBtn.disabled = currentPage >= Math.ceil(ordersCache.length / (perPageSelect.value === 'all' ? ordersCache.length : parseInt(perPageSelect.value, 10) || 10)));
}

function btnIsDisabled(el) {
  if (!el) return true;
  return el.hasAttribute('disabled') || el.disabled;
}

/* ---------------- WhatsApp integration ---------------- */
async function openWhatsApp(orderId) {
  try {
    if (!currentUser) { showToast('Usuario no autenticado', 3000, true); return; }
    const orderRef = doc(db, 'orders', orderId);
    const snap = await getDoc(orderRef);
    if (!snap.exists()) { showToast('Pedido no encontrado', 3000, true); return; }
    const data = snap.data();
    const phoneRaw = (data.customerData && (data.customerData.phone || data.customerData.telefono || data.customerData.mobile)) || '';
    if (!phoneRaw) { showToast('No hay teléfono del cliente', 3000, true); return; }
    const digits = phoneRaw.replace(/[^\d+]/g, '');
    const waNumber = digits.replace(/\D/g, '');
    if (!waNumber) { showToast('Número inválido', 3000, true); return; }

    // Update communicationStatus
    await updateDoc(orderRef, {
      communicationStatus: 'contacting',
      communicationBy: currentUser.uid,
      communicationUpdatedAt: serverTimestamp()
    });

    const defaultText = `Hola, soy ${currentUser.email || 'el repartidor'}. Estoy contactando sobre tu pedido ${orderId}.`;
    const text = encodeURIComponent(defaultText);
    const waUrl = `https://wa.me/${waNumber}?text=${text}`;
    window.open(waUrl, '_blank');
    showToast('Abriendo WhatsApp...');
  } catch (err) {
    console.error('openWhatsApp error', err);
    showToast('No se pudo abrir WhatsApp', 3000, true);
  }
}

/* ---------------- Assign modal flow ---------------- */
async function openAssignModal(orderId) {
  assignTargetOrderId = orderId;
  await populateUserSelectors();

  if (vendedoresTableBody) {
    vendedoresTableBody.innerHTML = '';
    activeVendedores.forEach(u => {
      const tr = document.createElement('tr');
      const nameHtml = `<div class="user-cell"><div class="user-name">${escapeHtml(u.displayName || u.name || u.email || u.id)}</div><div class="user-phone">${escapeHtml(u.phone || '')}</div></div>`;
      tr.innerHTML = `<td><input type="checkbox" data-uid="${u.id}" class="sel-vendedor"></td><td>${nameHtml}</td>`;
      vendedoresTableBody.appendChild(tr);
    });
  }

  if (motorizadosTableBody) {
    motorizadosTableBody.innerHTML = '';
    activeMotorizados.forEach(u => {
      const tr = document.createElement('tr');
      const nameHtml = `<div class="user-cell"><div class="user-name">${escapeHtml(u.displayName || u.name || u.email || u.id)}</div><div class="user-phone">${escapeHtml(u.phone || '')}</div></div>`;
      tr.innerHTML = `<td><input type="checkbox" data-uid="${u.id}" class="sel-motorizado"></td><td>${nameHtml}</td>`;
      motorizadosTableBody.appendChild(tr);
    });
  }

  if (assignModal) {
    assignModal.classList.remove('hidden');
    assignModal.setAttribute('aria-hidden', 'false');
  }
}

function closeAssignModal() {
  if (assignModal) {
    assignModal.classList.add('hidden');
    assignModal.setAttribute('aria-hidden', 'true');
  }
  assignTargetOrderId = null;
}
assignClose?.addEventListener('click', closeAssignModal);
assignCancel?.addEventListener('click', closeAssignModal);

assignConfirm?.addEventListener('click', async () => {
  try {
    if (!assignTargetOrderId) { showToast('Pedido no definido', 3000, true); closeAssignModal(); return; }
    if (currentUserRole !== 'administrador') { showToast('Solo administradores pueden asignar.', 3000, true); closeAssignModal(); return; }

    const selectedV = Array.from(document.querySelectorAll('.sel-vendedor:checked')).map(i => i.dataset.uid);
    const selectedM = Array.from(document.querySelectorAll('.sel-motorizado:checked')).map(i => i.dataset.uid);

    const updatePayload = {};
    if (selectedV.length) updatePayload.vendedorIds = selectedV;
    if (selectedM.length) updatePayload.motorizadoIds = selectedM;
    if (selectedV.length === 1) updatePayload.vendedor = selectedV[0];
    if (selectedM.length === 1) updatePayload.motorizado = selectedM[0];
    updatePayload.lastAssignedAt = serverTimestamp();

    const orderRef = doc(db, 'orders', assignTargetOrderId);
    await updateDoc(orderRef, updatePayload);
    showToast('Asignación guardada.');
    closeAssignModal();
  } catch (err) {
    console.error('Assign error:', err);
    showToast('Error asignando personal.', 3000, true);
  }
});

/* ---------------- Update states (role-based) ---------------- */
async function updateOrderPayment(orderId, newStatus) {
  try {
    // allow motorizado or administrador to mark payment, but on admin page admin will always be allowed
    if (!(currentUserRole === 'motorizado' || currentUserRole === 'administrador')) {
      showToast('No tienes permiso para marcar pago.', 3000, true);
      return;
    }
    const orderRef = doc(db, 'orders', orderId);
    await updateDoc(orderRef, {
      paymentStatus: newStatus,
      paymentUpdatedAt: serverTimestamp()
    });
    showToast('Pago actualizado.');
  } catch (err) {
    console.error('updateOrderPayment error:', err);
    showToast('No se pudo actualizar pago.', 3000, true);
  }
}

async function updateOrderShipping(orderId, newStatus) {
  try {
    // keep role checks but administrator bypasses them
    if (newStatus === 'enviado' && !(currentUserRole === 'vendedor' || currentUserRole === 'administrador')) {
      showToast('Solo vendedores pueden marcar enviado.', 3000, true);
      return;
    }
    if (newStatus === 'entregado' && !(currentUserRole === 'motorizado' || currentUserRole === 'administrador')) {
      showToast('Solo motorizados pueden marcar entregado.', 3000, true);
      return;
    }
    const orderRef = doc(db, 'orders', orderId);
    await updateDoc(orderRef, {
      shippingStatus: newStatus,
      shippingUpdatedAt: serverTimestamp(),
      status: newStatus
    });
    showToast('Estado de envío actualizado.');
  } catch (err) {
    console.error('updateOrderShipping error:', err);
    showToast('No se pudo actualizar estado de envío.', 3000, true);
  }
}

/* ---------------- View modal (real-time timeline) ---------------- */
async function openViewModal(orderId) {
  try {
    if (orderDocUnsubscribe) { orderDocUnsubscribe(); orderDocUnsubscribe = null; }
    if (viewModal) { viewModal.classList.remove('hidden'); viewModal.setAttribute('aria-hidden', 'false'); }
    if (orderTimeline) orderTimeline.innerHTML = '<p>Cargando estado...</p>';
    const orderRef = doc(db, 'orders', orderId);
    orderDocUnsubscribe = onSnapshot(orderRef, (snap) => {
      if (!snap.exists()) { if (orderTimeline) orderTimeline.innerHTML = '<p>Pedido no encontrado.</p>'; return; }
      const o = normalizeOrder({ id: snap.id, ...snap.data() });
      renderOrderTimeline(o);
    }, (err) => {
      console.error('order onSnapshot error:', err);
      showToast('Error obteniendo estado en tiempo real.', 3000, true);
    });
  } catch (err) {
    console.error('openViewModal error:', err);
    showToast('No se pudo abrir vista del pedido.', 3000, true);
  }
}
function closeViewModal() {
  if (viewModal) { viewModal.classList.add('hidden'); viewModal.setAttribute('aria-hidden', 'true'); }
  if (orderDocUnsubscribe) { orderDocUnsubscribe(); orderDocUnsubscribe = null; }
}
viewClose?.addEventListener('click', closeViewModal);
viewCloseBtn?.addEventListener('click', closeViewModal);

function renderOrderTimeline(o) {
  if (!orderTimeline) return;
  const entries = [];
  entries.push({ title: 'Creado', time: o._createdAt || o.orderDate || o.timestamp });
  if (o._vendedorIds && o._vendedorIds.length) entries.push({ title: `Vendedor(s) asignado(s): ${o._vendedorIds.join(', ')}`, time: o.lastAssignedAt || null });
  if (o._motorizadoIds && o._motorizadoIds.length) entries.push({ title: `Motorizado(s) asignado(s): ${o._motorizadoIds.join(', ')}`, time: o.lastAssignedAt || null });
  if (o.paymentStatus) entries.push({ title: `Pago: ${o.paymentStatus}`, time: o.paymentUpdatedAt || null });
  if (o.shippingStatus) entries.push({ title: `Envío: ${o.shippingStatus}`, time: o.shippingUpdatedAt || null });
  if (o.communicationStatus) entries.push({ title: `Comunicación: ${o.communicationStatus}`, time: o.communicationUpdatedAt || null });

  orderTimeline.innerHTML = '';
  const ul = document.createElement('ul'); ul.className = 'timeline';
  entries.forEach(en => {
    const li = document.createElement('li');
    li.innerHTML = `<div class="timeline-item"><div class="timeline-title">${escapeHtml(en.title)}</div><div class="timeline-time">${formatDate(en.time)}</div></div>`;
    ul.appendChild(li);
  });
  orderTimeline.appendChild(ul);
}

/* ---------------- Modal details (openOrderModal) - resolves images and builds detailed card ---------------- */
async function openOrderModal(order, opts = {}) {
  currentViewedOrder = order;
  if (orderModalTitle) orderModalTitle.textContent = `Pedido ${order.id}`;

  // Normalize items
  const rawItems = Array.isArray(order.items) ? order.items.map(it => ({
    id: it.id || it.productId || it.product_id || '',
    name: it.name || it.title || it.productName || 'Producto',
    qty: Number(it.quantity || it.qty || 1),
    price: Number(it.price || it.unitPrice || it.totalPrice || 0),
    imageRef: it.image || it.imageUrl || it.thumbnail || it.imagePath || it.storagePath || it.path || '',
    productId: it.productId || it.product_id || it.product || ''
  })) : [];

  // Resolve images
  const resolved = await Promise.all(rawItems.map(it => resolveImageUrl(it.imageRef, it.productId)));
  const items = rawItems.map((it, i) => ({ ...it, imageUrl: resolved[i] || '' }));

  // Build detail HTML (same structure as before)
  const container = document.createElement('div');
  container.style.display = 'grid';
  container.style.gridTemplateColumns = '1fr';
  container.style.gap = '12px';

  const cust = order.customerData || order.customer || {};
  const custName = cust.name || cust.Customname || cust.customName || order.customerName || '';
  const custEmail = cust.email || '';
  const custPhone = cust.phone || cust.telefono || '';
  const custAddress = (cust.address && (cust.address.line1 || cust.address)) || order.address || '';

  const custCard = document.createElement('div');
  custCard.style.display = 'flex';
  custCard.style.gap = '12px';
  custCard.style.alignItems = 'center';
  custCard.style.padding = '12px';
  custCard.className = 'card customer-card';

  const avatar = document.createElement('div');
  avatar.className = 'thumb';
  avatar.style.width = '72px';
  avatar.style.height = '72px';
  avatar.style.borderRadius = '8px';
  avatar.style.display = 'flex';
  avatar.style.alignItems = 'center';
  avatar.style.justifyContent = 'center';
  avatar.style.fontWeight = '700';
  avatar.style.background = '#f3f4f6';
  avatar.textContent = (custName ? custName.slice(0,2).toUpperCase() : 'CL');

  const meta = document.createElement('div');
  meta.style.flex = '1';
  meta.innerHTML = `<div style="font-weight:700;font-size:15px;">${escapeHtml(custName || '—')}</div>
                    <div style="font-size:13px;color:#6b7280;margin-top:6px;">${escapeHtml(custAddress || '')}</div>
                    <div style="margin-top:8px;font-size:13px;"><strong>Tel:</strong> ${escapeHtml(custPhone || '—')} &nbsp; <strong>Email:</strong> ${escapeHtml(custEmail || '—')}</div>`;

  custCard.appendChild(avatar);
  custCard.appendChild(meta);
  container.appendChild(custCard);

  // Products table
  const productsWrap = document.createElement('div');
  productsWrap.className = 'card';
  productsWrap.style.padding = '12px';

  const title = document.createElement('h3');
  title.style.margin = '0 0 8px 0';
  title.textContent = `Productos (${items.reduce((s,it)=>s+(it.qty||0),0)})`;
  productsWrap.appendChild(title);

  const table = document.createElement('table');
  table.style.width = '100%';
  table.style.borderCollapse = 'collapse';
  table.innerHTML = `<thead>
    <tr style="text-align:left;color:#6b7280;font-size:13px;">
      <th style="padding:8px 6px;">Imagen</th>
      <th style="padding:8px 6px;">Producto</th>
      <th style="padding:8px 6px;">Cant.</th>
      <th style="padding:8px 6px;">Precio unit.</th>
      <th style="padding:8px 6px;">Subtotal</th>
    </tr>
  </thead>`;

  const tbody = document.createElement('tbody');
  items.forEach(it => {
    const tr = document.createElement('tr');
    tr.style.borderTop = '1px solid #e5e7eb';

    // image cell
    const imgTd = document.createElement('td');
    imgTd.style.padding = '8px 6px';
    imgTd.style.width = '72px';
    if (it.imageUrl) {
      const img = document.createElement('img');
      img.src = it.imageUrl;
      img.alt = it.name;
      img.style.width = '64px';
      img.style.height = '64px';
      img.style.objectFit = 'cover';
      img.loading = 'lazy';
      imgTd.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.style.width = '64px';
      ph.style.height = '64px';
      ph.style.background = '#f3f4f6';
      ph.style.display = 'flex';
      ph.style.alignItems = 'center';
      ph.style.justifyContent = 'center';
      ph.style.color = '#9aa0a6';
      ph.style.fontWeight = '700';
      ph.textContent = (it.name ? it.name.slice(0,2).toUpperCase() : 'IMG');
      imgTd.appendChild(ph);
    }

    // name
    const nameTd = document.createElement('td');
    nameTd.style.padding = '8px 6px';
    nameTd.innerHTML = `<div style="font-weight:600">${escapeHtml(it.name)}</div>`;

    // qty
    const qtyTd = document.createElement('td');
    qtyTd.style.padding = '8px 6px';
    qtyTd.textContent = String(it.qty || 0);

    // unit price
    const priceTd = document.createElement('td');
    priceTd.style.padding = '8px 6px';
    priceTd.textContent = formatCurrency(it.price || 0, order.currency || 'USD');

    // subtotal
    const subTd = document.createElement('td');
    subTd.style.padding = '8px 6px';
    const subtotal = (it.price || 0) * (it.qty || 0);
    subTd.textContent = formatCurrency(subtotal, order.currency || 'USD');

    tr.appendChild(imgTd);
    tr.appendChild(nameTd);
    tr.appendChild(qtyTd);
    tr.appendChild(priceTd);
    tr.appendChild(subTd);
    tbody.appendChild(tr);
  });

  if (items.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 5;
    td.style.padding = '12px';
    td.style.textAlign = 'center';
    td.textContent = 'No hay productos listados en esta orden';
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  productsWrap.appendChild(table);

  // Totals and meta
  const metaWrap = document.createElement('div');
  metaWrap.style.display = 'flex';
  metaWrap.style.justifyContent = 'flex-end';
  metaWrap.style.marginTop = '12px';
  metaWrap.style.gap = '16px';

  const totals = document.createElement('div');
  totals.style.minWidth = '220px';
  totals.style.textAlign = 'right';
  totals.innerHTML = `
    <div style="font-size:13px;color:#6b7280">Subtotal: <span style="font-weight:700">${formatCurrency(order.subtotal || order.total || 0, order.currency || 'USD')}</span></div>
    <div style="font-size:13px;color:#6b7280;margin-top:6px">Envío: <span style="font-weight:700">${order.shippingFee ? formatCurrency(order.shippingFee, order.currency || 'USD') : '—'}</span></div>
    <div style="font-size:15px;margin-top:8px">Total: <span style="font-weight:900">${formatCurrency(order.total || order.amount || 0, order.currency || 'USD')}</span></div>
    <div style="font-size:13px;color:#6b7280;margin-top:8px">Pago: <strong>${escapeHtml(capitalize(order.paymentStatus || 'pending'))}</strong></div>
    <div style="font-size:13px;color:#6b7280;margin-top:4px">Envío: <strong>${escapeHtml(capitalize(order.shippingStatus || 'pending'))}</strong></div>
  `;
  metaWrap.appendChild(totals);

  container.appendChild(productsWrap);
  container.appendChild(metaWrap);

  // Inject into modal body
  if (orderDetailsEl) {
    orderDetailsEl.innerHTML = '';
    orderDetailsEl.appendChild(container);
  }

  // Configure assignSection visibility & fields by role
  try {
    if (assignSection) {
      if (currentUserRole === 'administrador') {
        assignSection.style.display = 'block';
        if (assignSellerSelect) assignSellerSelect.style.display = '';
        if (assignMotorSelect) assignMotorSelect.style.display = '';
        if (assignSellerSelect) assignSellerSelect.value = order.assignedSeller || '';
        if (assignMotorSelect) assignMotorSelect.value = order.assignedMotor || '';
        if (saveAssignBtn) { saveAssignBtn.style.display = ''; saveAssignBtn.disabled = false; }
      } else if (currentUserRole === 'vendedor') {
        assignSection.style.display = 'block';
        if (assignSellerSelect) assignSellerSelect.style.display = 'none';
        if (assignMotorSelect) assignMotorSelect.style.display = '';
        if (assignMotorSelect) assignMotorSelect.value = order.assignedMotor || '';
        if (!isOrderOwnedByCurrentUser(order)) {
          if (saveAssignBtn) { saveAssignBtn.disabled = true; saveAssignBtn.title = 'No autorizado para asignar este pedido'; }
        } else {
          if (saveAssignBtn) { saveAssignBtn.disabled = false; saveAssignBtn.title = ''; }
        }
        if (saveAssignBtn) saveAssignBtn.style.display = '';
      } else {
        assignSection.style.display = 'none';
      }
    }
  } catch (err) {
    console.error('Error configuring assignSection', err);
    if (assignSection) assignSection.style.display = 'none';
  }

  // Confirm delivery form
  if (currentUserRole === 'motorizado' && (order.assignedMotor === currentUser.uid || order.assignedMotorName === currentUser.email)) {
    if (confirmDeliveryForm) confirmDeliveryForm.classList.remove('hidden');
  } else {
    if (confirmDeliveryForm) confirmDeliveryForm.classList.add('hidden');
  }

  // Reset delivery inputs
  if (deliveryPaymentMethod) deliveryPaymentMethod.value = 'pago_movil';
  if (deliveryObs) deliveryObs.value = '';
  if (deliveryProof) deliveryProof.value = '';

  // Show modal
  if (orderModal) { orderModal.classList.remove('hidden'); orderModal.setAttribute('aria-hidden', 'false'); }
}

function closeOrderModal() {
  if (orderModal) { orderModal.classList.add('hidden'); orderModal.setAttribute('aria-hidden', 'true'); }
  currentViewedOrder = null;
}

/* Save assignments */
async function saveAssignments() {
  if (!currentViewedOrder) return;
  if (!currentUser) { showToast('No autenticado'); return; }

  const seller = assignSellerSelect ? assignSellerSelect.value || null : null;
  const motor = assignMotorSelect ? assignMotorSelect.value || null : null;

  try {
    const orderRef = doc(db, 'orders', currentViewedOrder.id);
    const snap = await getDoc(orderRef);
    if (!snap.exists()) { showToast('Pedido no encontrado'); return; }
    const currentData = snap.data();

    const updates = {};

    if (currentUserRole === 'administrador') {
      if (seller !== (currentViewedOrder.assignedSeller || null)) {
        updates.assignedSeller = seller || null;
        updates.assignedSellerName = assignSellerSelect.options[assignSellerSelect.selectedIndex] ? assignSellerSelect.options[assignSellerSelect.selectedIndex].text : '';
      }
      if (motor !== (currentViewedOrder.assignedMotor || null)) {
        updates.assignedMotor = motor || null;
        updates.assignedMotorName = assignMotorSelect.options[assignMotorSelect.selectedIndex] ? assignMotorSelect.options[assignMotorSelect.selectedIndex].text : '';
      }
    } else if (currentUserRole === 'vendedor') {
      if (!isOrderOwnedByCurrentUser(currentViewedOrder)) { showToast('No autorizado para asignar este pedido.'); return; }
      if (motor) {
        if (motor !== (currentViewedOrder.assignedMotor || null)) {
          updates.assignedMotor = motor;
          updates.assignedMotorName = assignMotorSelect.options[assignMotorSelect.selectedIndex] ? assignMotorSelect.options[assignMotorSelect.selectedIndex].text : '';
        }
      } else {
        updates.assignedMotor = null;
        updates.assignedMotorName = '';
      }
    } else {
      showToast('No tienes permiso para asignar.', 4000);
      return;
    }

    if (Object.keys(updates).length === 0) { showToast('No hay cambios que guardar.'); return; }

    if (updates.assignedMotor || updates.assignedSeller) {
      updates.shippingStatus = 'assigned';
      updates.shippingUpdatedAt = serverTimestamp();
    }
    updates.updatedAt = serverTimestamp();

    await updateDoc(orderRef, updates);
    showToast('Asignaciones guardadas.');
    closeOrderModal();
  } catch (err) {
    console.error('Error guardando asignaciones:', err);
    showToast('Error guardando asignaciones.', 5000);
  }
}

/* Confirm delivery by motorizado (with optional proof) */
async function confirmDelivery() {
  if (!currentViewedOrder) return;
  const method = deliveryPaymentMethod ? deliveryPaymentMethod.value || 'otro' : 'otro';
  const obs = deliveryObs ? deliveryObs.value || '' : '';
  const file = deliveryProof && deliveryProof.files && deliveryProof.files[0];

  if (file && file.size > 5 * 1024 * 1024) {
    showToast('El comprobante supera 5MB.');
    return;
  }

  try {
    const orderRef = doc(db, 'orders', currentViewedOrder.id);
    const updates = {
      shippingStatus: 'delivered',
      paymentStatus: 'paid',
      deliveryConfirmedAt: serverTimestamp(),
      deliveryNotes: obs,
      deliveryPaymentMethod: method,
      updatedAt: serverTimestamp()
    };

    if (file) {
      const safeName = `${Date.now()}_${file.name.replace(/\s+/g, '_')}`;
      const ref = storageRef(storage, `order_proofs/${currentViewedOrder.id}/${safeName}`);
      const snap = await uploadBytes(ref, file);
      const url = await getDownloadURL(snap.ref);
      updates.deliveryProofURL = url;
      updates.deliveryProofPath = snap.ref.fullPath || `order_proofs/${currentViewedOrder.id}/${safeName}`;
    }

    await updateDoc(orderRef, updates);
    showToast('Entrega confirmada. Pedido marcado como entregado y pagado.');
    closeOrderModal();
  } catch (err) {
    console.error('Error confirmando entrega:', err);
    showToast('Error confirmando entrega.', 5000);
  }
}

/* ---------------- Ownership helper ---------------- */
function isOrderOwnedByCurrentUser(order) {
  if (!order || !currentUser) return false;
  const uid = currentUser.uid;
  if (order.assignedSeller === uid) return true;
  if (Array.isArray(order.vendedorIds) && order.vendedorIds.includes(uid)) return true;
  if (order.createdBy === uid) return true;
  if (order.assignedSellerName && order.assignedSellerName === currentUser.email) return true;
  return false;
}

/* ---------------- CSV export (same as orders.js) ---------------- */
function exportVisibleCsv() {
  const visible = ordersCache.slice(); // already represents current query + client filters
  if (!visible.length) { showToast('No hay datos para exportar.'); return; }
  const headers = ['id', 'clientName', 'productTitle', 'createdAt', 'total', 'paymentStatus', 'shippingStatus', 'vendedor', 'motorizado'];
  const rows = visible.map(o => {
    const n = normalizeOrder(o);
    return headers.map(h => {
      if (h === 'createdAt') return formatDate(n._createdAt);
      if (h === 'vendedor') return (n._vendedorIds && n._vendedorIds.join(',')) || (n.vendedor || '') || (n.assignedSeller || '');
      if (h === 'motorizado') return (n._motorizadoIds && n._motorizadoIds.join(',')) || (n.motorizado || '') || (n.assignedMotor || '');
      const v = n[h] || n[h] === 0 ? n[h] : '';
      return String(v).replace(/,/g, '');
    }).join(',');
  });
  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url;
  a.download = `orders_export_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click(); URL.revokeObjectURL(url);
}

/* ---------------- Event wiring ---------------- */
prevPageBtn?.addEventListener('click', () => {
  if (currentPage > 1) {
    currentPage--;
    renderPage();
  }
});
nextPageBtn?.addEventListener('click', () => {
  const per = perPageSelect.value === 'all' ? ordersCache.length : parseInt(perPageSelect.value, 10) || 10;
  const totalPages = Math.max(1, Math.ceil(ordersCache.length / per));
  if (currentPage < totalPages) {
    currentPage++;
    renderPage();
  }
});
perPageSelect?.addEventListener('change', () => {
  currentPage = 1;
  renderPage();
});
applyFiltersBtn?.addEventListener('click', () => {
  subscribeOrders();
});
clearFiltersBtn?.addEventListener('click', () => {
  if (searchInput) searchInput.value = '';
  if (paymentFilter) paymentFilter.value = '';
  if (shippingFilter) shippingFilter.value = '';
  if (sellerFilter) sellerFilter.value = '';
  if (motorFilter) motorFilter.value = '';
  if (dateFrom) dateFrom.value = '';
  if (dateTo) dateTo.value = '';
  if (perPageSelect) perPageSelect.value = '10';
  subscribeOrders();
});
refreshBtn?.addEventListener('click', () => {
  subscribeOrders();
});
downloadCsvBtn?.addEventListener('click', (e) => {
  e && e.preventDefault();
  exportVisibleCsv();
});

closeOrderModalBtn?.addEventListener('click', closeOrderModal);
saveAssignBtn?.addEventListener('click', saveAssignments);
confirmDeliveryBtn?.addEventListener('click', confirmDelivery);

// close modal on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeOrderModal();
    closeAssignModal();
    closeViewModal();
  }
});

// Search Enter triggers
searchInput?.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') subscribeOrders();
});

/* ---------------- Auth state & initialization ---------------- */
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    console.warn('No user signed in.');
    return;
  }
  currentUser = user;
  try {
    const userDocRef = doc(db, 'users', user.uid);
    const userDocSnap = await getDoc(userDocRef);
    if (userDocSnap.exists()) {
      currentUserRole = userDocSnap.data().role || 'vendedor';
    } else {
      currentUserRole = 'vendedor';
      try {
        await addDoc(collection(db, 'users'), { email: user.email || '', role: 'vendedor', createdAt: serverTimestamp() });
      } catch (_) { /* ignore */ }
    }

    await populateUserSelectors();
    subscribeOrders();
    showToast(`Conectado como ${currentUserRole}`, 2000);
  } catch (err) {
    console.error('Error obteniendo rol de usuario:', err);
    showToast('Error iniciando la gestión de pedidos.');
  }
});

/* ---------------- Export / public API (optional) ---------------- */
export { subscribeOrders, populateUserSelectors };