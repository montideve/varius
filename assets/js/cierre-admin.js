// Módulo Cierre de Caja (vanilla JS + Firebase v12 modular)
// Actualizado: mejoras en filtrado por rol, agregación más robusta de pagos,
// y pequeñas correcciones para UX y consistencia.

import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import {
    getAuth,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import {
    getFirestore,
    collection,
    query,
    where,
    orderBy,
    getDocs,
    addDoc,
    doc,
    serverTimestamp,
    getDoc
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const cierreDateEl = document.getElementById('cierreDate');
const dateSelect = document.getElementById('dateSelect');
const calcBtn = document.getElementById('calcBtn');
const refreshBtn = document.getElementById('refreshBtn');

const kpiTotal = document.getElementById('kpiTotal');
const kpiOrders = document.getElementById('kpiOrders');
const kpiCash = document.getElementById('kpiCash');
const kpiDigital = document.getElementById('kpiDigital');

const breakdownList = document.getElementById('breakdownList');

const reconPhysical = document.getElementById('reconPhysical');
const reconNotes = document.getElementById('reconNotes');
const reconResult = document.getElementById('reconResult');
const saveReconBtn = document.getElementById('saveReconBtn');

const closeDayBtn = document.getElementById('closeDayBtn');
const toastEl = document.getElementById('toast');

let currentUser = null;
let currentUserRole = null;

function hideToast() {
    if (!toastEl) return;
    // quitar la clase show y añadir hidden después de la transición
    toastEl.classList.remove('show');
    // asegurar que se oculte definitivamente tras pequeña demora para permitir la animación
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => {
        toastEl.classList.add('hidden');
    }, 220); // coincide con la transición en CSS
}


// Helper: toast
function showToast(msg, timeout = 3500) {
    if (!toastEl) {
        // fallback
        alert(msg);
        return;
    }
    // mensaje
    toastEl.textContent = msg;

    // preparar: limpiar timers previos
    clearTimeout(toastEl._t);

    // mostrar: quitar hidden y añadir show para animar
    toastEl.classList.remove('hidden');
    // forzar reflow no estrictamente necesario, pero garantiza que la transición se aplique
    // eslint-disable-next-line no-unused-expressions
    toastEl.offsetHeight;
    toastEl.classList.add('show');

    // programar ocultado
    toastEl._t = setTimeout(() => {
        // quitar la clase show y luego ocultar por completo
        toastEl.classList.remove('show');
        // asegurar que tras la transición quede hidden
        toastEl._t = setTimeout(() => {
            toastEl.classList.add('hidden');
        }, 220);
    }, timeout);
}

// Helpers formatting
function formatCurrency(n) {
    // Mejor intentar detectar la moneda local; aquí usamos USD como fallback.
    try {
        return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(n || 0);
    } catch (e) {
        return `${Number(n || 0).toFixed(2)} USD`;
    }
}

function percentOf(part, total) {
    if (!total) return '0%';
    return `${((part / total) * 100).toFixed(1)}%`;
}

function setKpis({ total = 0, orders = 0, cash = 0, digital = 0 }) {
    kpiTotal.textContent = formatCurrency(total);
    kpiOrders.textContent = String(orders);
    kpiCash.textContent = formatCurrency(cash);
    kpiDigital.textContent = formatCurrency(digital);
}

// Render breakdown array: [{ method, amount, transactions }]
function renderBreakdown(breakdown = []) {
    breakdownList.innerHTML = '';
    if (!breakdown.length) {
        const li = document.createElement('li');
        li.className = 'breakdown-item';
        li.innerHTML = `<div style="padding:12px;color:var(--muted)">No hay transacciones para la fecha seleccionada.</div>`;
        breakdownList.appendChild(li);
        return;
    }

    breakdown.forEach(b => {
        const li = document.createElement('li');
        li.className = 'breakdown-item';
        li.innerHTML = `
      <div class="left">
        <div class="icon">${methodIcon(b.method)}</div>
        <div>
          <div style="font-weight:600">${capitalizeMethod(b.method)}</div>
          <div class="meta">${b.transactions || 0} transacciones</div>
        </div>
      </div>
      <div class="amount">
        <div style="font-weight:600">${formatCurrency(b.amount || 0)}</div>
        <div class="percent">${b.percent || '0%'}</div>
      </div>
    `;
        breakdownList.appendChild(li);
    });
}

function methodIcon(method) {
    switch ((method || '').toLowerCase()) {
        case 'cash': return '💵';
        case 'efectivo': return '💵';
        case 'pago_movil': return '📲';
        case 'mobile': return '📲';
        case 'usd': return '💶';
        case 'card_debit':
        case 'debit':
        case 'card_debito':
        case 'tarjeta debito':
        case 'tarjeta_débito': return '💳';
        case 'card_credit':
        case 'credit':
        case 'tarjeta credito':
        case 'tarjeta_crédito': return '💳';
        case 'paypal': return '🅿️';
        default: return '💸';
    }
}

function capitalizeMethod(m) {
    if (!m) return 'Otro';
    return String(m).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Determina si un pedido debe ser visible según el rol del usuario.
 * - administrador: todos
 * - motorizado: assignedMotor === uid OR communicationBy === uid (fallback)
 * - vendedor: createdBy === uid OR assignedSeller === uid OR assignedSellerId === uid
 */
function orderVisibleForRole(orderData, uid, role) {
    if (role === 'administrador') return true;
    if (!orderData) return false;
    if (role === 'motorizado') {
        return orderData.assignedMotor === uid || orderData.communicationBy === uid || orderData.motorizadoId === uid;
    }
    if (role === 'vendedor') {
        return orderData.createdBy === uid || orderData.assignedSeller === uid || orderData.assignedSellerId === uid || orderData.sellerId === uid;
    }
    // por defecto mostrar solo si createdBy coincide
    return orderData.createdBy === uid;
}

/**
 * Agrega monto al mapa de breakdown por método.
 */
function addMethodToMap(map, method, amount) {
    const key = (method || 'other').toString().toLowerCase();
    if (!map[key]) map[key] = { amount: 0, transactions: 0, method: key };
    map[key].amount += Number(amount || 0);
    map[key].transactions += 1;
}

/**
 * Agregación principal para una fecha.
 * Lee orders y suma según pagos registrados.
 */
async function aggregateForDate(dayISO) {
    const start = new Date(dayISO + 'T00:00:00');
    const end = new Date(dayISO + 'T23:59:59.999');

    // Query: traemos los pedidos ordenados por orderDate desc (luego filtramos por rango)
    const ordersCol = collection(db, 'orders');
    const q = query(ordersCol, orderBy('orderDate', 'desc'));
    const snap = await getDocs(q);

    const orders = [];
    snap.forEach(s => {
        const data = s.data();
        // normalizar orderDate
        const od = data.orderDate && data.orderDate.toDate ? data.orderDate.toDate() : (data.orderDate ? new Date(data.orderDate) : null);
        if (!od) return;
        if (od >= start && od <= end) {
            orders.push({ id: s.id, ...data });
        }
    });

    // Filtrar según rol/usuario (si aplica)
    const uid = currentUser ? currentUser.uid : null;
    const role = currentUserRole || null;
    const visibleOrders = orders.filter(o => orderVisibleForRole(o, uid, role));

    // Ahora agregamos
    let total = 0;
    let ordersCount = visibleOrders.length;
    const breakdownMap = {}; // key => { amount, transactions }

    // Helper para procesar un payment object/array
    function processPaymentRecord(p) {
        // support multiple shapes
        if (!p) return;
        // If payment stores methods array (our payment-modal)
        if (Array.isArray(p.methods) && p.methods.length) {
            p.methods.forEach(m => addMethodToMap(breakdownMap, m.method || m.currency || 'other', m.amount || 0));
            return;
        }
        // If payment is object with breakdown array
        if (Array.isArray(p.breakdown) && p.breakdown.length) {
            p.breakdown.forEach(b => addMethodToMap(breakdownMap, b.method || b.name || 'other', b.amount || 0));
            return;
        }
        // If has amount and method directly
        if (p.amount !== undefined) {
            addMethodToMap(breakdownMap, p.method || 'other', p.amount);
            return;
        }
    }

    // Iterate visible orders
    for (const o of visibleOrders) {
        const amount = Number(o.total || o.amount || 0);
        total += amount;

        let handled = false;

        // 1) If inline "payment" object (from the payment-modal implementation)
        if (o.payment && typeof o.payment === 'object' && Object.keys(o.payment).length) {
            processPaymentRecord(o.payment);
            handled = true;
        }

        // 2) If inline payments array (legacy)
        if (!handled && Array.isArray(o.payments) && o.payments.length) {
            o.payments.forEach(p => processPaymentRecord(p));
            handled = true;
        }

        // 3) If object payments map
        if (!handled && o.payments && typeof o.payments === 'object' && Object.keys(o.payments).length) {
            Object.values(o.payments).forEach(p => processPaymentRecord(p));
            handled = true;
        }

        // 4) Try subcollection orders/{id}/payments (best-effort; may be empty)
        if (!handled) {
            try {
                const paymentsSnap = await getDocs(collection(db, 'orders', o.id, 'payments'));
                if (!paymentsSnap.empty) {
                    paymentsSnap.forEach(ps => {
                        processPaymentRecord(ps.data());
                    });
                    handled = true;
                }
            } catch (err) {
                console.warn('No se pudieron leer subcolecciones payments para order', o.id, err);
                // fallback below
            }
        }

        // 5) fallback: asignar todo el monto al método 'other' o según paymentMethod/paymentType
        if (!handled) {
            const method = o.paymentMethod || o.paymentType || (o.paymentStatus === 'pagado' ? 'other' : 'other');
            addMethodToMap(breakdownMap, method || 'other', amount);
        }
    }

    // Convert map to array and calculate percentages
    const breakdown = Object.keys(breakdownMap).map(k => {
        const item = breakdownMap[k];
        return { method: item.method, amount: item.amount, transactions: item.transactions };
    });

    // Calculate cash/digital split (best-effort)
    const cashKeys = ['cash', 'efectivo', 'bs', 'boleto']; // augment as needed
    const cashTotal = breakdown.reduce((s, b) => s + (cashKeys.includes((b.method || '').toLowerCase()) ? b.amount : 0), 0);
    const digitalTotal = Math.max(0, total - cashTotal);

    // Add percent to each breakdown item
    breakdown.forEach(b => b.percent = percentOf(b.amount, total));

    return { total, ordersCount, breakdown, cashTotal, digitalTotal, orders: visibleOrders };
}

// SAVE cierre document into "cash_closures" collection
async function saveClosure(payload) {
    const col = collection(db, 'cash_closures');
    return await addDoc(col, { ...payload, createdAt: serverTimestamp() });
}

// Event handlers
calcBtn.addEventListener('click', async () => {
    const dayISO = dateSelect.value || (new Date()).toISOString().slice(0, 10);
    cierreDateEl.textContent = humanDate(dayISO);
    showToast('Calculando cierre, esto puede tardar según número de pedidos...', 2500);
    try {
        const res = await aggregateForDate(dayISO);
        setKpis({ total: res.total, orders: res.ordersCount, cash: res.cashTotal, digital: res.digitalTotal });
        renderBreakdown(res.breakdown);
        // store last aggregated in memory for potential save
        window.__lastCierreCalc = { date: dayISO, ...res };
        reconResult.textContent = 'Pendiente';
        reconResult.className = 'badge';
        showToast('Cálculo completado');
    } catch (err) {
        console.error('Error calculando cierre:', err);
        showToast('Error calculando cierre (ver consola)');
    }
});

refreshBtn.addEventListener('click', () => {
    calcBtn.click();
});

saveReconBtn.addEventListener('click', async () => {
    const last = window.__lastCierreCalc;
    if (!last) {
        showToast('Primero calcula el cierre antes de conciliar.');
        return;
    }
    const physical = parseFloat(reconPhysical.value || '0');
    const diff = physical - last.total;
    if (Math.abs(diff) < 0.005) {
        reconResult.textContent = 'Conciliado';
        reconResult.className = 'badge';
    } else {
        reconResult.textContent = `Diferencia ${formatCurrency(diff)}`;
        reconResult.className = 'badge';
    }
    window.__lastReconciliation = { physical, notes: reconNotes.value || '', diff };
    showToast('Conciliación guardada localmente. Pulsa Cerrar caja del día para registrar en Firestore.');
});

closeDayBtn.addEventListener('click', async () => {
    const last = window.__lastCierreCalc;
    if (!last) {
        showToast('Calcula el cierre antes de cerrarlo.');
        return;
    }
    if (!currentUser) { showToast('No autenticado'); return; }
    const payload = {
        date: last.date,
        totals: { total: last.total, orders: last.ordersCount, cash: last.cashTotal, digital: last.digitalTotal },
        breakdown: last.breakdown,
        reconciled: window.__lastReconciliation || null,
        createdBy: currentUser.uid,
        createdByEmail: currentUser.email || null
    };

    // owner field: administrador no limita, vendedores/motorizados dejan owner para ellos
    if ((currentUserRole === 'vendedor' || currentUserRole === 'motorizado')) {
        payload.owner = currentUser.uid;
    }

    try {
        await saveClosure(payload);
        showToast('Cierre guardado correctamente en Firestore');
    } catch (err) {
        console.error('Error guardando cierre:', err);
        showToast('Error guardando cierre (ver consola)');
    }
});

// onAuthStateChanged: load role and prepare dateSelect
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        showToast('No autenticado');
        return;
    }
    currentUser = user;

    try {
        const userDocRef = doc(db, 'users', user.uid);
        const userDoc = await getDoc(userDocRef);
        currentUserRole = userDoc && userDoc.exists() ? userDoc.data().role || 'vendedor' : 'vendedor';
    } catch (err) {
        console.error('Error leyendo role:', err);
        currentUserRole = 'vendedor';
    }

    // Populate dateSelect with last 14 days (simple UX)
    populateDateOptions();

    // Auto-calc for today
    dateSelect.value = (new Date()).toISOString().slice(0, 10);
    calcBtn.click();
});

// small util: populate last 14 days
function populateDateOptions() {
    const today = new Date();
    dateSelect.innerHTML = '';
    for (let i = 0; i < 14; i++) {
        const d = new Date(today);
        d.setDate(today.getDate() - i);
        const iso = d.toISOString().slice(0, 10);
        const opt = document.createElement('option');
        opt.value = iso;
        opt.text = `${iso} — ${d.toLocaleDateString()}`;
        dateSelect.appendChild(opt);
    }
}

// utility human date for header
function humanDate(iso) {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}