// assets/js/order-view-modal.js
// Módulo para mostrar modal de detalle/timeline de pedido.
// Ahora verifica que el usuario autenticado esté asociado al pedido antes de mostrar.

import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

const modal = document.getElementById('viewModal');
const modalBody = document.getElementById('viewModalBody');
const closeBtn = document.getElementById('viewModalClose');
const viewCloseBtn = document.getElementById('viewCloseBtn');

let currentUser = null;
onAuthStateChanged(auth, (u) => { currentUser = u; });

function openModal() {
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
}

function closeModal() {
    if (!modal) return;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    if (modalBody) modalBody.innerHTML = '<div id="orderTimeline"></div>';
}

async function renderOrder(orderId) {
    if (!modalBody) return;
    modalBody.innerHTML = '<div style="padding:12px">Cargando...</div>';
    try {
        const ref = doc(db, 'orders', orderId);
        const snap = await getDoc(ref);
        if (!snap.exists()) {
            modalBody.innerHTML = '<div style="padding:12px">Pedido no encontrado.</div>';
            return;
        }
        const data = snap.data();

        // Protección: solo mostrar si currentUser está asociado al pedido
        const allowed = currentUser && (
            data.assignedMotor === currentUser.uid ||
            data.assignedSeller === currentUser.uid ||
            data.assignedSellerId === currentUser.uid ||
            data.customerId === currentUser.uid ||
            data.customerUid === currentUser.uid
        );

        if (!allowed) {
            modalBody.innerHTML = '<div style="padding:12px; color:var(--muted)">No autorizado para ver este pedido.</div>';
            return;
        }

        const timeline = document.createElement('div');
        timeline.className = 'timeline';
        const rows = [];

        const pushRow = (title, subtitle) => rows.push({ title, subtitle });

        pushRow('Pedido creado', (data.createdAt && data.createdAt.toDate) ? data.createdAt.toDate().toLocaleString() : (data.orderDate ? new Date(data.orderDate).toLocaleString() : '-'));
        pushRow('Estado envío', data.shippingStatus || '-');
        if (data.shippingUpdatedAt) pushRow('Última actualización envío', (data.shippingUpdatedAt.toDate ? data.shippingUpdatedAt.toDate().toLocaleString() : String(data.shippingUpdatedAt)));
        if (data.deliveredAt) pushRow('Entregado', (data.deliveredAt.toDate ? data.deliveredAt.toDate().toLocaleString() : String(data.deliveredAt)));
        if (data.communicationStatus) pushRow('Comunicación', `${data.communicationStatus} ${data.communicationBy ? 'por ' + data.communicationBy : ''}`);
        if (data.assignedSellerName || data.assignedSeller) pushRow('Vendedor', data.assignedSellerName || data.assignedSeller);
        if (data.assignedMotorName || data.assignedMotor) pushRow('Motorizado', data.assignedMotorName || data.assignedMotor);
        if (data.customerData) {
            pushRow('Cliente', (data.customerData.name || data.customerData.Customname || data.customerName || '-'));
            if (data.customerData.phone) pushRow('Teléfono', data.customerData.phone);
            if (data.customerData.address) pushRow('Dirección', data.customerData.address);
        }
        if (data.paymentRegistered) {
            pushRow('Cobro', `Registrado: ${data.paymentTotal || '-'}`);
            if (data.paymentDetails && data.paymentDetails.proofUrl) {
                pushRow('Soporte pago', data.paymentDetails.proofUrl);
            }
        }

        rows.forEach(r => {
            const item = document.createElement('div');
            item.className = 'timeline-item';
            item.innerHTML = `<div>
        <div class="timeline-title">${escapeHtml(r.title)}</div>
        <div class="timeline-time">${escapeHtml(r.subtitle)}</div>
      </div>`;
            timeline.appendChild(item);
        });

        modalBody.innerHTML = '';
        modalBody.appendChild(timeline);
    } catch (err) {
        console.error('Error cargando detalle de pedido:', err);
        modalBody.innerHTML = '<div style="padding:12px">Error cargando pedido.</div>';
    }
}

function escapeHtml(s) {
    if (s === undefined || s === null) return '';
    return String(s).replace(/[&<>"'`=\/]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
}

document.addEventListener('motorizado:open-order', (ev) => {
    const id = ev.detail?.orderId;
    if (!id) return;
    openModal();
    renderOrder(id);
});
document.addEventListener('vendedor:open-order', (ev) => {
    const id = ev.detail?.orderId;
    if (!id) return;
    openModal();
    renderOrder(id);
});

if (closeBtn) closeBtn.addEventListener('click', closeModal);
if (viewCloseBtn) viewCloseBtn.addEventListener('click', closeModal);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });