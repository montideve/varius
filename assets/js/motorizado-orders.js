// assets/js/motorizado-orders.js
// Versión ajustada: oculta botón de cobro si pedido ya pagado
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
    onSnapshot,
    doc,
    getDoc,
    updateDoc,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";

import { openPaymentModal } from './payment-modal.js'; // modal de pago

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

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
let ordersCache = [];
let activeFilter = {};

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

async function ensureRoleIsMotorized(user) {
    try {
        const userRef = doc(db, 'users', user.uid);
        const snap = await getDoc(userRef);
        const role = snap.exists() ? (snap.data().role || '') : '';
        currentUserRole = role;
        return role === 'motorizado';
    } catch (err) {
        console.error('Error leyendo rol:', err);
        return false;
    }
}

function hideAdminControls() {
    document.querySelectorAll('.admin-only').forEach(el => el.remove());
}

function toDateSafe(value) {
    if (!value) return null;
    if (value.toDate) return value.toDate();
    try { return new Date(value); } catch (e) { return null; }
}

function listenMotorOrders(uid) {
    if (unsubscribeOrders) {
        unsubscribeOrders();
        unsubscribeOrders = null;
    }
    const ordersCol = collection(db, 'orders');

    // Sin orderBy para evitar requerir índice en Firestore.
    const q = query(ordersCol, where('assignedMotor', '==', uid));

    unsubscribeOrders = onSnapshot(q, snapshot => {
        const arr = [];
        snapshot.forEach(docSnap => arr.push({ id: docSnap.id, ...docSnap.data() }));
        // Ordenar en cliente por orderDate (desc). Si no existe orderDate, usar createdAt.
        arr.sort((a, b) => {
            const da = toDateSafe(a.orderDate || a.createdAt);
            const dbt = toDateSafe(b.orderDate || b.createdAt);
            if (!da && !dbt) return 0;
            if (!da) return 1;
            if (!dbt) return -1;
            return dbt - da;
        });
        ordersCache = arr;
        renderOrders();
    }, err => {
        console.error('Orders onSnapshot error:', err);
        showToast('No se pudo conectar a pedidos en tiempo real.', true);
    });
}

function normalizeOrder(raw) {
    const o = { ...raw };
    o.clientName = (raw.customerData && (raw.customerData.Customname || raw.customerData.name || raw.customerData.customName)) || raw.customerName || raw.customer || (raw.customer && raw.customer.name) || '';
    o.productTitle = (Array.isArray(raw.items) && raw.items.length) ? raw.items.map(i => i.name || i.title || '').join(', ') : (raw.productTitle || raw.productName || '');
    o._orderDate = raw.orderDate && raw.orderDate.toDate ? raw.orderDate.toDate() : (raw.orderDate ? new Date(raw.orderDate) : raw.createdAt && raw.createdAt.toDate ? raw.createdAt.toDate() : null);
    o.paymentStatus = (raw.paymentStatus || raw.payment || '').toString().toLowerCase();
    o.shippingStatus = (raw.shippingStatus || raw.status || '').toString().toLowerCase();
    return o;
}

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
        const shippingBadge = `<td><span class="badge ${o.shippingStatus === 'entregado' ? 'badge-done' : (o.shippingStatus === 'enviado' ? 'badge-onroute' : 'badge-pending')}">${escapeHtml(o.shippingStatus || 'pendiente')}</span></td>`;
        const sellerTd = `<td>${escapeHtml(o.assignedSellerName || o.assignedSeller || '—')}</td>`;
        const motorTd = `<td>${escapeHtml(o.assignedMotorName || o.assignedMotor || '—')}</td>`;

        const btnView = `<button class="icon-btn view-btn" data-order="${o.id}" title="Ver pedido">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-eye" viewBox="0 0 16 16"><path d="M16 8s-3-5.5-8-5.5S0 8 0 8s3 5.5 8 5.5S16 8 16 8M1.173 8a13 13 0 0 1 1.66-2.043C4.12 4.668 5.88 3.5 8 3.5s3.879 1.168 5.168 2.457A13 13 0 0 1 14.828 8q-.086.13-.195.288c-.335.48-.83 1.12-1.465 1.755C11.879 11.332 10.119 12.5 8 12.5s-3.879-1.168-5.168-2.457A13 13 0 0 1 1.172 8z"/><path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5M4.5 8a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0"/></svg>
        </button>`;

        const phone = (o.customerData && (o.customerData.phone || o.customerData.telefono || o.customerData.mobile)) || '';
        const whatsappBtn = `<button class="icon-btn whatsapp-btn" data-order="${o.id}" ${phone ? '' : 'disabled'} title="${phone ? 'Abrir WhatsApp' : 'No hay teléfono disponible'}">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-whatsapp" viewBox="0 0 16 16"><path d="M13.601 2.326A7.85 7.85 0 0 0 7.994 0C3.627 0 .068 3.558.064 7.926c0 1.399.366 2.76 1.057 3.965L0 16l4.204-1.102a7.9 7.9 0 0 0 3.79.965h.004c4.368 0 7.926-3.558 7.93-7.93A7.9 7.9 0 0 0 13.6 2.326zM7.994 14.521a6.6 6.6 0 0 1-3.356-.92l-.24-.144-2.494.654.666-2.433-.156-.251a6.56 6.56 0 0 1-1.007-3.505c0-3.626 2.957-6.584 6.591-6.584a6.56 6.56 0 0 1 4.66 1.931 6.56 6.56 0 0 1 1.928 4.66c-.004 3.639-2.961 6.592-6.592 6.592m3.615-4.934c-.197-.099-1.17-.578-1.353-.646-.182-.065-.315-.099-.445.099-.133.197-.513.646-.627.775-.114.133-.232.148-.43.05-.197-.1-.836-.308-1.592-.985-.59-.525-.985-1.175-1.103-1.372-.114-.198-.011-.304.088-.403.087-.088.197-.232.296-.346.1-.114.133-.198.198-.33.065-.134.034-.248-.015-.347-.05-.099-.445-1.076-.612-1.47-.16-.389-.323-.335-.445-.34-.114-.007-.247-.007-.38-.007a.73.73 0 0 0-.529.247c-.182.198-.691.677-.691 1.654s.71 1.916.81 2.049c.098.133 1.394 2.132 3.383 2.992.47.205.84.326 1.129.418.475.152.904.129 1.246.08.38-.058 1.171-.48 1.338-.943.164-.464.164-.86.114-.943-.049-.084-.182-.133-.38-.232"/></svg>
        </button>`;

        // Mostrar botón de cobro SOLO si no está pagado
        let btnDeliver = '';
        if (!(o.paymentStatus === 'pagado' || o.paymentStatus === 'paid')) {
            btnDeliver = `<button class="icon-btn deliver-btn" data-order="${o.id}" title="Registrar cobranza">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-cash-coin" viewBox="0 0 16 16"><path fill-rule="evenodd" d="M11 15a4 4 0 1 0 0-8 4 4 0 0 0 0 8m5-4a5 5 0 1 1-10 0 5 5 0 0 1 10 0"/><path d="M9.438 11.944c.047.596.518 1.06 1.363 1.116v.44h.375v-.443c.875-.061 1.386-.529 1.386-1.207 0-.618-.39-.936-1.09-1.1l-.296-.07v-1.2c.376.043.614.248.671.532h.658c-.047-.575-.54-1.024-1.329-1.073V8.5h-.375v.45c-.747.073-1.255.522-1.255 1.158 0 .562.378.92 1.007 1.066l.248.061v1.272c-.384-.058-.639-.27-.696-.563h-.668zm1.36-1.354c-.369-.085-.569-.26-.569-.522 0-.294.216-.514.572-.578v1.1zm.432.746c.449.104.655.272.655.569 0 .339-.257.571-.709.614v-1.195z"/></svg>
            </button>`;
        } else {
            btnDeliver = `<span style="font-size:12px; color:var(--muted)">Cobrado</span>`;
        }

        const actionsTd = `<td class="actions">${btnView} ${whatsappBtn} ${btnDeliver}</td>`;

        tr.innerHTML = `${idTd}${clientTd}${productTd}${dateTd}${totalTd}${paymentBadge}${shippingBadge}${sellerTd}${motorTd}${actionsTd}`;
        tbody.appendChild(tr);
    });

    if (kpiAssigned) kpiAssigned.textContent = String(visible.length);

    // Bind handlers
    document.querySelectorAll('.view-btn').forEach(btn => {
        btn.onclick = () => openViewModal(btn.dataset.order);
    });

    // WhatsApp handler
    document.querySelectorAll('.whatsapp-btn').forEach(btn => {
        btn.onclick = async () => {
            const orderId = btn.dataset.order;
            try {
                if (!currentUser) { showToast('Usuario no autenticado', true); return; }
                const orderRef = doc(db, 'orders', orderId);
                const snap = await getDoc(orderRef);
                if (!snap.exists()) { showToast('Pedido no encontrado', true); return; }
                const data = snap.data();
                const phoneRaw = (data.customerData && (data.customerData.phone || data.customerData.telefono || data.customerData.mobile)) || '';
                if (!phoneRaw) { showToast('No hay teléfono del cliente', true); return; }
                const digits = phoneRaw.replace(/[^\d+]/g, '');
                const waNumber = digits.replace(/\D/g, '');
                if (!waNumber) { showToast('Número inválido', true); return; }

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
                console.error('WhatsApp action error:', err);
                showToast('No se pudo abrir WhatsApp', true);
            }
        };
    });

    // Deliver button handler -> abre modal de cobro con el objeto de pedido completo
    document.querySelectorAll('.deliver-btn').forEach(btn => {
        btn.onclick = () => {
            const orderId = btn.dataset.order;
            const orderObj = ordersCache.find(x => x.id === orderId);
            if (!orderObj) { showToast('Pedido no encontrado', true); return; }
            openPaymentModal(orderObj);
        };
    });
}

function openViewModal(orderId) {
    const ev = new CustomEvent('motorizado:open-order', { detail: { orderId } });
    document.dispatchEvent(ev);
}

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

// Escuchar evento de confirmación de pago desde payment-modal
document.addEventListener('payment:confirmed', (e) => {
    const orderId = e?.detail?.orderId;
    if (orderId) {
        showToast('Cobranza registrada correctamente.');
        // onSnapshot actualizará la tabla, pero forzamos render con cache actualizada si se encuentra:
        // (el snapshot normal debe actualizar correctamente, esto es solo UX inmediata)
        const idx = ordersCache.findIndex(o => o.id === orderId);
        if (idx >= 0) {
            ordersCache[idx].paymentStatus = 'pagado';
            renderOrders();
        }
    }
});

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = '/index.html';
        return;
    }
    currentUser = user;
    const isMotor = await ensureRoleIsMotorized(user);
    if (!isMotor) {
        const userRef = doc(db, 'users', user.uid);
        const snap = await getDoc(userRef);
        const role = snap.exists() ? (snap.data().role || '') : '';
        if (role === 'administrador') window.location.href = '/admin/administrador.html';
        else if (role === 'vendedor') window.location.href = '/admin/vendedor.html';
        else window.location.href = '/index.html';
        return;
    }

    hideAdminControls();
    listenMotorOrders(user.uid);

    showToast('Conectado como motorizado — mostrando tus pedidos');
});