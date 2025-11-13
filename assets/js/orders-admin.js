import { firebaseConfig } from './firebase-config.js'; // Ajusta el path si es necesario
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
  setDoc,
  serverTimestamp,
  limit,
  startAfter
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";
import {
  getStorage,
  ref as storageRef,
  uploadBytes,
  getDownloadURL
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-storage.js";

// Inicializa Firebase (solo si no está inicializado)
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

// UI elementos
const ordersBody = document.getElementById('ordersBody');
const pageInfo = document.getElementById('pageInfo');
const prevPageBtn = document.getElementById('prevPage');
const nextPageBtn = document.getElementById('nextPage');
const perPageSelect = document.getElementById('perPageSelect');
const searchInput = document.getElementById('searchInput');
const paymentFilter = document.getElementById('paymentFilter');
const shippingFilter = document.getElementById('shippingFilter');
const sellerFilter = document.getElementById('sellerFilter');
const motorFilter = document.getElementById('motorFilter');
const dateFrom = document.getElementById('dateFrom');
const dateTo = document.getElementById('dateTo');
const applyFiltersBtn = document.getElementById('applyFilters');
const clearFiltersBtn = document.getElementById('clearFilters');
const refreshBtn = document.getElementById('refreshBtn');

// Modal elementos
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
const toastEl = document.getElementById('toast');

let currentUser = null;
let currentUserRole = null;
let unsubscribeOrders = null;
let ordersCache = []; // snapshot array used for client-side pagination
let currentPage = 1;
let perPage = 10;
let currentViewedOrder = null;

// Helper: mostrar toast
function showToast(msg, timeout = 3500) {
  if (!toastEl) {
    alert(msg);
    return;
  }
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  setTimeout(() => {
    toastEl.classList.add('hidden');
  }, timeout);
}

// Util: crea un badge según estado
function badgeHtml(text, cls = '') {
  const span = document.createElement('span');
  span.className = `badge ${cls}`;
  span.textContent = text;
  return span;
}

// Carga lista de usuarios por rol para selects de asignación
async function populateUserSelectors() {
  // Limpiamos
  assignSellerSelect.innerHTML = '<option value="">-- seleccionar --</option>';
  assignMotorSelect.innerHTML = '<option value="">-- seleccionar --</option>';
  sellerFilter.innerHTML = '<option value="">Todos</option>';
  motorFilter.innerHTML = '<option value="">Todos</option>';

  try {
    const usersCol = collection(db, 'users');
    // Tomamos todos los usuarios (para proyectos pequeños). Si son muchos, paginar.
    const usersSnap = await getDocs(usersCol);
    usersSnap.forEach(docSnap => {
      const u = { id: docSnap.id, ...docSnap.data() };
      if (u.role === 'vendedor') {
        const opt = document.createElement('option');
        opt.value = u.id;
        opt.textContent = u.email || u.name || u.id;
        assignSellerSelect.appendChild(opt);
        sellerFilter.appendChild(opt.cloneNode(true));
      }
      if (u.role === 'motorizado') {
        const optM = document.createElement('option');
        optM.value = u.id;
        optM.textContent = u.email || u.name || u.id;
        assignMotorSelect.appendChild(optM);
        motorFilter.appendChild(optM.cloneNode(true));
      }
    });
  } catch (err) {
    console.error('Error cargando usuarios:', err);
  }
}

// Construir query según rol y filtros
function buildOrdersQuery() {
  const ordersCol = collection(db, 'orders');
  let q = query(ordersCol, orderBy('orderDate', 'desc'));

  // Filtros básicos (client-side para algunos complejos: búsqueda libre, rango de fechas)
  // Para filtros simples que Firestore soporta, podemos añadir where() para eficiencia
  const pay = paymentFilter ? paymentFilter.value : '';
  const ship = shippingFilter ? shippingFilter.value : '';
  const sellerSel = sellerFilter ? sellerFilter.value : '';
  const motorSel = motorFilter ? motorFilter.value : '';

  // Filtrado por role: si vendedor -> assignedSeller == currentUser.uid
  if (currentUserRole === 'vendedor') {
    q = query(ordersCol, where('assignedSeller', '==', currentUser.uid), orderBy('orderDate', 'desc'));
  } else if (currentUserRole === 'motorizado') {
    q = query(ordersCol, where('assignedMotor', '==', currentUser.uid), orderBy('orderDate', 'desc'));
  } else {
    // admin y otros: aplicamos filtros opcionales
    const whereClauses = [];
    if (pay) whereClauses.push(where('paymentStatus', '==', pay));
    if (ship) whereClauses.push(where('shippingStatus', '==', ship));
    if (sellerSel) whereClauses.push(where('assignedSeller', '==', sellerSel));
    if (motorSel) whereClauses.push(where('assignedMotor', '==', motorSel));
    if (whereClauses.length) {
      // Aplicar todos los where en cadena
      q = query(ordersCol, ...whereClauses, orderBy('orderDate', 'desc'));
    }
  }

  return q;
}

// Suscribirse a orders en tiempo real (cuando filtros se apliquen)
function subscribeOrders() {
  if (unsubscribeOrders) {
    unsubscribeOrders();
    unsubscribeOrders = null;
  }

  const q = buildOrdersQuery();

  unsubscribeOrders = onSnapshot(q, snapshot => {
    const items = [];
    snapshot.forEach(docSnap => {
      items.push({ id: docSnap.id, ...docSnap.data() });
    });

    // Aplicar filtros client-side adicionales:
    const s = (searchInput && searchInput.value || '').trim().toLowerCase();
    const from = dateFrom && dateFrom.value ? new Date(dateFrom.value) : null;
    const to = dateTo && dateTo.value ? new Date(dateTo.value) : null;

    let filtered = items.filter(o => {
      // búsqueda por id, nombre o correo
      if (s) {
        const idMatch = o.id.toLowerCase().includes(s);
        const name = (o.customerData && (o.customerData.name || '')) || '';
        const email = (o.customerData && (o.customerData.email || '')) || '';
        if (!(idMatch || name.toLowerCase().includes(s) || email.toLowerCase().includes(s))) return false;
      }
      // fecha
      if (from || to) {
        if (!o.orderDate) return false;
        const od = o.orderDate.toDate ? o.orderDate.toDate() : new Date(o.orderDate);
        if (from && od < from) return false;
        if (to && od > (new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59))) return false;
      }
      return true;
    });

    // Guardamos en cache y renderizamos la página actual
    ordersCache = filtered;
    currentPage = 1;
    renderPage();
  }, err => {
    console.error('Snapshot error:', err);
    showToast('Error recibiendo pedidos en tiempo real.');
  });
}

// Renderizado de filas (paginación client-side)
function renderPage() {
  perPage = perPageSelect ? perPageSelect.value : '10';
  const per = perPage === 'all' ? ordersCache.length || 1e9 : parseInt(perPage, 10) || 10;
  const total = ordersCache.length;
  const totalPages = Math.max(1, Math.ceil(total / per));
  if (currentPage > totalPages) currentPage = totalPages;

  const start = (currentPage - 1) * per;
  const end = start + per;

  const pageItems = ordersCache.slice(start, end);

  ordersBody.innerHTML = '';
  pageItems.forEach(o => {
    const tr = document.createElement('tr');

    // ID
    const tdId = document.createElement('td');
    tdId.textContent = o.id;
    tr.appendChild(tdId);

    // Cliente
    const tdCust = document.createElement('td');
    const name = o.customerData && (o.customerData.name || '');
    const email = o.customerData && (o.customerData.email || '');
    tdCust.innerHTML = `<div style="font-weight:600">${escapeHtml(name || email || '—')}</div><div style="color:#6b7280;font-size:12px">${escapeHtml(email)}</div>`;
    tr.appendChild(tdCust);

    // Items summary
    const tdItems = document.createElement('td');
    const itemsCount = Array.isArray(o.items) ? o.items.length : 0;
    tdItems.textContent = `${itemsCount} item(s)`;
    tr.appendChild(tdItems);

    // Total
    const tdTotal = document.createElement('td');
    tdTotal.textContent = o.total ? `${formatCurrency(o.total, o.currency || 'USD')}` : '—';
    tr.appendChild(tdTotal);

    // Pago
    const tdPay = document.createElement('td');
    const payStatus = o.paymentStatus || 'pending';
    const payBadge = badgeHtml(capitalize(payStatus), payStatus === 'paid' ? 'paid' : 'pending');
    tdPay.appendChild(payBadge);
    tr.appendChild(tdPay);

    // Envío
    const tdShip = document.createElement('td');
    const shipStatus = o.shippingStatus || 'pending';
    const shipCls = shipStatus === 'delivered' ? 'delivered' : shipStatus === 'in_transit' ? 'in_transit' : '';
    tdShip.appendChild(badgeHtml(capitalize(shipStatus), shipCls));
    tr.appendChild(tdShip);

    // Vendedor
    const tdSeller = document.createElement('td');
    tdSeller.textContent = (o.assignedSellerName || o.assignedSeller || '—');
    tr.appendChild(tdSeller);

    // Motorizado
    const tdMotor = document.createElement('td');
    tdMotor.textContent = (o.assignedMotorName || o.assignedMotor || '—');
    tr.appendChild(tdMotor);

    // Fecha
    const tdDate = document.createElement('td');
    if (o.orderDate) {
      const d = o.orderDate.toDate ? o.orderDate.toDate() : new Date(o.orderDate);
      tdDate.textContent = d.toLocaleString();
    } else {
      tdDate.textContent = '—';
    }
    tr.appendChild(tdDate);

    // Acciones
    const tdActions = document.createElement('td');
    tdActions.className = 'actions';

    // Ver detalles botón
    const viewBtn = document.createElement('button');
    viewBtn.className = 'icon-btn';
    viewBtn.textContent = 'Ver';
    viewBtn.addEventListener('click', () => openOrderModal(o));
    tdActions.appendChild(viewBtn);

    // Asignar motorizado (admin y vendedor)
    if (currentUserRole === 'administrador' || currentUserRole === 'vendedor') {
      const assignBtn = document.createElement('button');
      assignBtn.className = 'icon-btn';
      assignBtn.textContent = 'Asignar';
      assignBtn.addEventListener('click', () => openOrderModal(o, { openAssign: true }));
      tdActions.appendChild(assignBtn);
    }

    // Confirmar entrega (motorizado)
    if (currentUserRole === 'motorizado' && o.assignedMotor === currentUser.uid && o.shippingStatus !== 'delivered') {
      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'icon-btn';
      confirmBtn.textContent = 'Confirmar';
      confirmBtn.addEventListener('click', () => openOrderModal(o, { delivery: true }));
      tdActions.appendChild(confirmBtn);
    }

    tr.appendChild(tdActions);
    ordersBody.appendChild(tr);
  });

  pageInfo.textContent = `${currentPage} / ${totalPages} (${ordersCache.length} pedidos)`;
  prevPageBtn.disabled = currentPage <= 1;
  nextPageBtn.disabled = currentPage >= totalPages;
}

// Seguridad: escape string for innerHTML usage
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"'`=\/]/g, s => {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[s] || s;
  });
}

function formatCurrency(amount, currency = 'USD') {
  try {
    return new Intl.NumberFormat('es-VE', { style: 'currency', currency }).format(amount);
  } catch (e) {
    return `${amount} ${currency}`;
  }
}

function capitalize(str) {
  if (!str) return '';
  return String(str).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Abrir modal de pedido (detalles, asignar, confirmar)
function openOrderModal(order, opts = {}) {
  currentViewedOrder = order;
  orderModalTitle.textContent = `Pedido ${order.id}`;
  orderDetailsEl.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div>
        <strong>Cliente:</strong> ${escapeHtml((order.customerData && (order.customerData.name || order.customerData.email)) || '—')}<br/>
        <strong>Dirección:</strong> ${escapeHtml(order.customerData && order.customerData.address || '—')}<br/>
        <strong>Tel:</strong> ${escapeHtml(order.customerData && order.customerData.phone || '—')}
      </div>
      <div>
        <strong>Items:</strong>
        <ul style="margin:6px 0 0 16px;padding:0;">
          ${Array.isArray(order.items) ? order.items.map(i => `<li style="font-size:13px;">${escapeHtml(i.name || i.title || 'item')} x${i.quantity || 1} — ${i.price ? formatCurrency(i.price, order.currency) : ''}</li>`).join('') : '<li>—</li>'}
        </ul>
      </div>
    </div>
    <div style="margin-top:8px;">
      <strong>Total:</strong> ${order.total ? formatCurrency(order.total, order.currency || 'USD') : '—'}<br/>
      <strong>Pago:</strong> ${capitalize(order.paymentStatus || 'pending')}<br/>
      <strong>Envío:</strong> ${capitalize(order.shippingStatus || 'pending')}
    </div>
  `;

  // Mostrar/u ocultar secciones según rol
  if (currentUserRole === 'administrador' || currentUserRole === 'vendedor') {
    assignSection.style.display = 'block';
    // rellenar selects con valores existentes
    assignSellerSelect.value = order.assignedSeller || '';
    assignMotorSelect.value = order.assignedMotor || '';
  } else {
    assignSection.style.display = 'none';
  }

  if (currentUserRole === 'motorizado') {
    // Mostrar formulario de confirmación si este motorizado es asignado al pedido
    if (order.assignedMotor === currentUser.uid) {
      confirmDeliveryForm.classList.remove('hidden');
    } else {
      confirmDeliveryForm.classList.add('hidden');
    }
  } else {
    confirmDeliveryForm.classList.add('hidden');
  }

  // Abrir modal
  orderModal.classList.remove('hidden');
  orderModal.setAttribute('aria-hidden', 'false');

  // Reset delivery inputs
  deliveryPaymentMethod.value = 'pago_movil';
  deliveryObs.value = '';
  if (deliveryProof) deliveryProof.value = '';
}

// Cerrar modal
function closeOrderModal() {
  orderModal.classList.add('hidden');
  orderModal.setAttribute('aria-hidden', 'true');
  currentViewedOrder = null;
}

// Guardar asignaciones (admin/vendedor)
async function saveAssignments() {
  if (!currentViewedOrder) return;
  const seller = assignSellerSelect.value || null;
  const motor = assignMotorSelect.value || null;

  try {
    const orderRef = doc(db, 'orders', currentViewedOrder.id);
    const updates = {};
    if (seller !== (currentViewedOrder.assignedSeller || null)) {
      updates.assignedSeller = seller || null;
      updates.assignedSellerName = assignSellerSelect.options[assignSellerSelect.selectedIndex] ? assignSellerSelect.options[assignSellerSelect.selectedIndex].text : '';
    }
    if (motor !== (currentViewedOrder.assignedMotor || null)) {
      updates.assignedMotor = motor || null;
      updates.assignedMotorName = assignMotorSelect.options[assignMotorSelect.selectedIndex] ? assignMotorSelect.options[assignMotorSelect.selectedIndex].text : '';
    }
    // Si alguna asignacion aplicada, cambiamos status a "assigned"
    if (updates.assignedMotor || updates.assignedSeller) {
      updates.shippingStatus = 'assigned';
    }
    updates.updatedAt = serverTimestamp();
    await updateDoc(orderRef, updates);
    showToast('Asignaciones guardadas.');
    closeOrderModal();
  } catch (err) {
    console.error('Error guardando asignaciones:', err);
    showToast('Error guardando asignaciones.');
  }
}

// Confirmación de entrega por motorizado
async function confirmDelivery() {
  if (!currentViewedOrder) return;
  // Validaciones simples
  const method = deliveryPaymentMethod.value || 'otro';
  const obs = deliveryObs.value || '';
  const file = deliveryProof.files && deliveryProof.files[0];

  // Limitar tamaño 5MB
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
      deliveryPaymentMethod: method
    };

    if (file) {
      // Subir a Storage
      const fileRef = storageRef(storage, `order_proofs/${currentViewedOrder.id}/${Date.now()}_${file.name}`);
      const snap = await uploadBytes(fileRef, file);
      const url = await getDownloadURL(snap.ref);
      updates.deliveryProofURL = url;
    }

    await updateDoc(orderRef, updates);
    showToast('Entrega confirmada. Pedido marcado como entregado y pagado.');
    closeOrderModal();
  } catch (err) {
    console.error('Error confirmando entrega:', err);
    showToast('Error confirmando entrega.');
  }
}

// Eventos UI: paginación
prevPageBtn.addEventListener('click', () => {
  if (currentPage > 1) {
    currentPage--;
    renderPage();
  }
});
nextPageBtn.addEventListener('click', () => {
  const per = perPage === 'all' ? ordersCache.length || 1e9 : parseInt(perPage, 10) || 10;
  const totalPages = Math.max(1, Math.ceil(ordersCache.length / per));
  if (currentPage < totalPages) {
    currentPage++;
    renderPage();
  }
});
perPageSelect.addEventListener('change', () => {
  currentPage = 1;
  renderPage();
});
applyFiltersBtn.addEventListener('click', () => {
  subscribeOrders();
});
clearFiltersBtn.addEventListener('click', () => {
  searchInput.value = '';
  paymentFilter.value = '';
  shippingFilter.value = '';
  sellerFilter.value = '';
  motorFilter.value = '';
  dateFrom.value = '';
  dateTo.value = '';
  perPageSelect.value = '10';
  subscribeOrders();
});
refreshBtn.addEventListener('click', () => {
  subscribeOrders();
});

// Modal controls
closeOrderModalBtn.addEventListener('click', closeOrderModal);
saveAssignBtn.addEventListener('click', saveAssignments);
confirmDeliveryBtn.addEventListener('click', confirmDelivery);

// Cerrar modal con ESC
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeOrderModal();
});

// Cuando cambie usuario autenticado, obtenemos su rol y suscribimos a orders
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    // Si no hay usuario, redirigir o mostrar login (según flujo de tu app)
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
      // Document no existe: asignar vendedor por defecto
      currentUserRole = 'vendedor';
      await setDoc(userDocRef, {
        email: user.email,
        role: 'vendedor',
        createdAt: serverTimestamp()
      });
    }
    // Poblar usuarios para selects
    await populateUserSelectors();

    // Suscribirse a orders segun role y filtros
    subscribeOrders();

    showToast(`Conectado como ${currentUserRole}`);
  } catch (err) {
    console.error('Error obteniendo rol de usuario:', err);
    showToast('Error iniciando la gestión de pedidos.');
  }
});

// Search input: disparar filtros al presionar Enter
searchInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') subscribeOrders();
});

// Inicial: poblar selects (si el usuario ya está cargado)
populateUserSelectors();

// Export (si necesitas llamar a logout u otras funciones desde UI)
export { subscribeOrders, populateUserSelectors };