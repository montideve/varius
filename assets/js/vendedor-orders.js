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
    onSnapshot,
    doc,
    getDoc,
    updateDoc,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";

// Inicializa app (reusa si ya existe)
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// DOM refs (coinciden con los IDs del HTML copiado del admin)
const tbody = document.getElementById('ordersTbody');
const applyBtn = document.getElementById('applyFilters');
const resetBtn = document.getElementById('resetFilters');
const searchInput = document.getElementById('q');
const downloadCsvBtn = document.getElementById('downloadCsv');
const toastEl = document.getElementById('toast');
const kpiAssigned = document.getElementById('kpi-assigned');

let currentUser = null;
let currentUserRole = null;
let unsubscribeOrders = null;
let ordersCache = []; // cache local para poder filtrar client-side
let activeFilter = {};

// Helper de UI
function showToast(msg, isError = false, ms = 3500) {
    if (!toastEl) return alert(msg);
    toastEl.textContent = msg;
    toastEl.style.background = isError ? '#b91c1c' : '#111827';
    toastEl.classList.remove('hidden');
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => toastEl.classList.add('hidden'), ms);
}

function escapeHtml(s) {
    if (s === undefined || s === null) return '';
    return String(s).replace(/[&<>"'`=\/]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
}

function formatDate(ts) {
    if (!ts) return '-';
    if (ts.toDate) ts = ts.toDate();
    const d = new Date(ts);
    return d.toLocaleString();
}

// Validation & role-check: después de login comprobamos users/{uid}.role
async function ensureRoleIsSeller(user) {
    try {
        const userRef = doc(db, 'users', user.uid);
        const snap = await getDoc(userRef);
        const role = snap.exists() ? (snap.data().role || '') : '';
        currentUserRole = role;
        return role === 'vendedor';
    } catch (err) {
        console.error('Error leyendo rol:', err);
        return false;
    }
}

// Ocultar controles admin-only (visual)
function hideAdminControls() {
    document.querySelectorAll('.admin-only').forEach(el => el.remove());
}

// Construir query para pedidos del vendedor
function listenSellerOrders(uid) {
    if (unsubscribeOrders) {
        unsubscribeOrders();
        unsubscribeOrders = null;
    }

    // Intentamos los nombres de campo más comunes (assignedSeller)
    // Si tu BD usa vendedor / sellerId / assignedSellerId, ajusta según corresponda.
    const ordersCol = collection(db, 'orders');
    const q = query(ordersCol, where('assignedSeller', '==', uid), orderBy('orderDate', 'desc'));

    unsubscribeOrders = onSnapshot(q, snapshot => {
        const arr = [];
        snapshot.forEach(docSnap => arr.push({ id: docSnap.id, ...docSnap.data() }));
        ordersCache = arr;
        renderOrders(); // renderizamos con filtros actuales
    }, err => {
        console.error('Orders onSnapshot error:', err);
        showToast('No se pudo conectar a pedidos en tiempo real.', true);
    });
}

// Normalización ligera del pedido (soporta customerData.Customname)
function normalizeOrder(raw) {
    const o = { ...raw };
    o.clientName = (raw.customerData && (raw.customerData.Customname || raw.customerData.name || raw.customerData.customName)) || raw.customerName || raw.customer || (raw.customer && raw.customer.name) || '';
    o.productTitle = (Array.isArray(raw.items) && raw.items.length) ? raw.items.map(i => i.name || i.title || '').join(', ') : (raw.productTitle || raw.productName || '');
    o._orderDate = raw.orderDate && raw.orderDate.toDate ? raw.orderDate.toDate() : (raw.orderDate ? new Date(raw.orderDate) : raw.createdAt && raw.createdAt.toDate ? raw.createdAt.toDate() : null);
    o.paymentStatus = (raw.paymentStatus || raw.payment || '').toString().toLowerCase();
    o.shippingStatus = (raw.shippingStatus || raw.status || '').toString().toLowerCase();
    return o;
}

// Match filters (fecha/producto/estado/search)
function matchesFilters(o, filters) {
    if (filters.fechaInicio) {
        const start = new Date(filters.fechaInicio); start.setHours(0, 0, 0, 0);
        if (!o._orderDate || o._orderDate < start) return false;
    }
    if (filters.fechaFin) {
        const end = new Date(filters.fechaFin); end.setHours(23, 59, 59, 999);
        if (!o._orderDate || o._orderDate > end) return false;
    }
    if (filters.productoFiltro) {
        if (!o.productTitle || !o.productTitle.toLowerCase().includes(filters.productoFiltro.toLowerCase())) return false;
    }
    if (filters.estadoPago) {
        if ((o.paymentStatus || '') !== filters.estadoPago) return false;
    }
    if (filters.estadoEnvio) {
        if ((o.shippingStatus || '') !== filters.estadoEnvio) return false;
    }
    if (filters.search) {
        const s = filters.search.toLowerCase();
        const possible = [
            (o.clientName || '').toLowerCase(),
            (o.productTitle || '').toLowerCase(),
            (o.id || '').toLowerCase()
        ];
        if (!possible.some(p => p.includes(s))) return false;
    }
    return true;
}

// Render tabla
function renderOrders() {
    if (!tbody) return;
    tbody.innerHTML = '';
    const visible = ordersCache.map(normalizeOrder).filter(o => matchesFilters(o, activeFilter));
    if (visible.length === 0) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td colspan="10" style="text-align:center;padding:18px;">No hay pedidos para mostrar</td>`;
        tbody.appendChild(tr);
        if (kpiAssigned) kpiAssigned.textContent = '0';
        return;
    }

    visible.forEach(o => {
        const tr = document.createElement('tr');

        const idTd = `<td>${escapeHtml(o.id)}</td>`;
        const clientTd = `<td>${escapeHtml(o.clientName || '')}</td>`;
        const productTd = `<td>${escapeHtml(o.productTitle || '')}</td>`;
        const dateTd = `<td>${formatDate(o._orderDate)}</td>`;
        const totalTd = `<td>${escapeHtml(o.total || o.amount || 0)}</td>`;
        const paymentBadge = `<td><span class="badge ${o.paymentStatus === 'pagado' || o.paymentStatus === 'paid' ? 'paid' : 'pending'}">${escapeHtml(o.paymentStatus || 'pendiente')}</span></td>`;
        const shippingBadge = `<td><span class="badge ${o.shippingStatus === 'entregado' ? 'delivered' : (o.shippingStatus === 'enviado' ? 'shipped' : 'pending')}">${escapeHtml(o.shippingStatus || 'pendiente')}</span></td>`;
        const sellerTd = `<td>${escapeHtml(o.assignedSellerName || o.assignedSeller || '')}</td>`;
        const motorTd = `<td>${escapeHtml(o.assignedMotorName || o.assignedMotor || '')}</td>`;

        // Acciones: vendedor puede ver detalle y marcar "enviado" (si la app lo permite)
        const btnView = `<button class="icon-btn view-btn" data-order="${o.id}">Ver</button>`;
        // habilitar mark-sent solo si vendedor y pedido asignado parcialmente ok
        const canMarkSent = true; // lógica adicional si la quieres
        const btnMarkSent = `<button class="icon-btn mark-sent" data-order="${o.id}" ${canMarkSent ? '' : 'disabled'} title="${canMarkSent ? '' : 'Requiere asignaciones'}">Marcar enviado</button>`;

        const actionsTd = `<td class="actions">${btnView} ${btnMarkSent}</td>`;

        tr.innerHTML = `${idTd}${clientTd}${productTd}${dateTd}${totalTd}${paymentBadge}${shippingBadge}${sellerTd}${motorTd}${actionsTd}`;
        tbody.appendChild(tr);
    });

    // contador KPI simple
    if (kpiAssigned) kpiAssigned.textContent = String(visible.length);

    // Attach handlers for dynamic items (delegation could be used instead)
    document.querySelectorAll('.view-btn').forEach(btn => {
        btn.onclick = () => openViewModal(btn.dataset.order);
    });
    document.querySelectorAll('.mark-sent').forEach(btn => {
        btn.onclick = async () => {
            const orderId = btn.dataset.order;
            try {
                const orderRef = doc(db, 'orders', orderId);
                await updateDoc(orderRef, { shippingStatus: 'enviado', shippingUpdatedAt: serverTimestamp() });
                showToast('Pedido marcado como enviado.');
            } catch (err) {
                console.error('Error marcando enviado:', err);
                showToast('Error marcando enviado.', true);
            }
        };
    });
}

// Open view modal (reutiliza modal IDs del HTML)
function openViewModal(orderId) {
    // Dispatch event that orders.js / other modules might listen to, o simplemente abrir modal aquí.
    const ev = new CustomEvent('vendedor:open-order', { detail: { orderId } });
    document.dispatchEvent(ev);
}

// Filtros: lectura y aplicación
function readFilters() {
    return {
        fechaInicio: document.getElementById('fechaInicio')?.value || '',
        fechaFin: document.getElementById('fechaFin')?.value || '',
        productoFiltro: document.getElementById('productoFiltro')?.value || '',
        estadoPago: document.getElementById('estadoPago')?.value || '',
        estadoEnvio: document.getElementById('estadoEnvio')?.value || '',
        motorizadoFiltro: document.getElementById('motorizadoFiltro')?.value || '',
        search: (searchInput?.value || '').trim()
    };
}
applyBtn?.addEventListener('click', () => { activeFilter = readFilters(); renderOrders(); });
resetBtn?.addEventListener('click', () => { document.getElementById('ordersFilters')?.reset(); searchInput.value = ''; activeFilter = {}; renderOrders(); });
searchInput?.addEventListener('keypress', (e) => { if (e.key === 'Enter') { activeFilter = readFilters(); renderOrders(); } });

// CSV export: opcional para vendedores — lo ocultamos por defecto, pero si quieres permitirlo, remueve el hideAdminControls()
if (downloadCsvBtn) {
    downloadCsvBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const visible = ordersCache.map(normalizeOrder).filter(o => matchesFilters(o, activeFilter));
        if (!visible.length) { showToast('No hay datos para exportar.'); return; }
        const headers = ['id', 'clientName', 'productTitle', 'createdAt', 'total', 'paymentStatus', 'shippingStatus'];
        const rows = visible.map(o => headers.map(h => {
            if (h === 'createdAt') return formatDate(o._orderDate);
            return `"${String(o[h] || '').replace(/"/g, '""')}"`;
        }).join(','));
        const csv = [headers.join(','), ...rows].join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = `orders_${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(url);
    });
}

// onAuth: validar rol y suscribirse a pedidos del vendedor
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        // si no hay sesion redirigir al login (o index)
        window.location.href = '/index.html';
        return;
    }
    currentUser = user;
    const isSeller = await ensureRoleIsSeller(user);
    if (!isSeller) {
        // si no es vendedor redirigir a su página correspondiente
        const userRef = doc(db, 'users', user.uid);
        const snap = await getDoc(userRef);
        const role = snap.exists() ? (snap.data().role || '') : '';
        if (role === 'administrador') window.location.href = '/admin/administrador.html';
        else if (role === 'motorizado') window.location.href = '/admin/motorizado.html';
        else window.location.href = '/index.html';
        return;
    }

    // Hide admin-only controls to ensure UI doesn't offer admin features
    hideAdminControls();

    // Suscribirse solo a pedidos asignados al vendedor
    listenSellerOrders(user.uid);

    showToast('Conectado como vendedor — mostrando solo tus pedidos');
});