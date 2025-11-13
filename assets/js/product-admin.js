// product-admin.js
// Página de administración de productos: CRUD + filtros + modal.
// SKU autogenerado según categoría y no editable.
// Ubicación: assets/js/product-admin.js
// Se asume que firebase-config.js existe en el mismo folder (assets/js/firebase-config.js)

import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import {
    getAuth, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import {
    getFirestore, collection, query, orderBy, onSnapshot,
    addDoc, doc, updateDoc, deleteDoc, getDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";
import {
    getStorage, ref as storageRef, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-storage.js";

// Inicializa app si no está inicializada
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

// UI
const productsBody = document.getElementById('productsBody');
const searchInput = document.getElementById('searchInput');
const stateFilter = document.getElementById('stateFilter');
const offerFilter = document.getElementById('offerFilter');

const productModal = document.getElementById('productModal');
const openAddBtn = document.getElementById('openAddBtn');
const closeModalBtn = document.getElementById('closeModal');
const cancelBtn = document.getElementById('cancelBtn');

const productForm = document.getElementById('productForm');
const modalTitle = document.getElementById('modalTitle');
const toast = document.getElementById('toast');

// Form fields
const productIdField = document.getElementById('productId');
const nameField = document.getElementById('name');
const descriptionField = document.getElementById('description');
const priceField = document.getElementById('price');
const categoryField = document.getElementById('category');
const statusField = document.getElementById('status');
const onOfferField = document.getElementById('onOffer');
const discountField = document.getElementById('discount');
const stockField = document.getElementById('stock');
const imageFileField = document.getElementById('imageFile');
const skuField = document.getElementById('sku');

let productsLocal = [];
let currentUser = null;
let isEditing = false;
let editingId = null;
let prevImageUrl = '';
let prevSku = ''; // SKU existente al editar

// Mapeo de prefijos por categoría para generar SKU.
// Puedes ajustar los prefijos como quieras.
const CATEGORY_PREFIX = {
    "Ropa": "ROP",
    "Electrónica": "ELE",
    "Hogar": "HOG",
    "Accesorios": "ACC"
};

// Utility: toast
function showToast(msg, ms = 3000) {
    toast.textContent = msg;
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), ms);
}

// Format price CLP
function formatPrice(num) {
    if (num === undefined || num === null || num === '') return '-';
    return Number(num).toLocaleString('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 });
}

function calculateOfferPrice(price, discount) {
    if (!price || !discount) return null;
    return Math.round(Number(price) * (1 - Number(discount) / 100));
}

// Generador de SKU: PREFIJO-<timestamp corta o aleatorio>
// Ej: ELE-241125 (últimos 6 digitos de timestamp) o ELE-AB12
function generateSKUForCategory(category) {
    const prefix = CATEGORY_PREFIX[category] || (category ? category.slice(0, 3).toUpperCase() : 'PRD');
    // usar timestamp corto para que sea predecible y suficientemente único
    const timePortion = String(Date.now()).slice(-6);
    // agregar un sufijo aleatorio de 2 chars alfanum para reducir colisiones
    const rnd = Math.random().toString(36).slice(-4).toUpperCase();
    return `${prefix}-${timePortion}${rnd}`;
}

// Render
function renderProducts(list) {
    productsBody.innerHTML = '';
    if (!list.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 9;
        td.style.padding = '28px';
        td.style.textAlign = 'center';
        td.style.color = '#6b7280';
        td.textContent = 'No hay productos';
        tr.appendChild(td);
        productsBody.appendChild(tr);
        return;
    }

    list.forEach(prod => {
        const tr = document.createElement('tr');

        // Imagen
        const tdImg = document.createElement('td');
        const thumb = document.createElement('div');
        thumb.className = 'thumb';
        if (prod.imageUrl) {
            const img = document.createElement('img');
            img.src = prod.imageUrl;
            img.alt = prod.name;
            img.style.width = '100%';
            img.style.height = '100%';
            img.style.objectFit = 'cover';
            img.style.borderRadius = '6px';
            thumb.innerHTML = '';
            thumb.appendChild(img);
        } else {
            thumb.textContent = 'IMG';
        }
        tdImg.appendChild(thumb);
        tr.appendChild(tdImg);

        // Nombre y categoría
        const tdName = document.createElement('td');
        tdName.className = 'product-name';
        const title = document.createElement('div');
        title.textContent = prod.name;
        const cat = document.createElement('div');
        cat.style.fontSize = '12px';
        cat.style.color = '#6b7280';
        cat.textContent = prod.category || '';
        tdName.appendChild(title);
        tdName.appendChild(cat);
        tr.appendChild(tdName);

        // Precio
        const tdPrice = document.createElement('td');
        tdPrice.textContent = formatPrice(prod.price);
        tr.appendChild(tdPrice);

        // Oferta
        const tdOffer = document.createElement('td');
        const offerBadge = document.createElement('span');
        offerBadge.className = 'badge';
        offerBadge.textContent = prod.onOffer ? 'En oferta' : 'No';
        tdOffer.appendChild(offerBadge);
        tr.appendChild(tdOffer);

        // Descuento
        const tdDiscount = document.createElement('td');
        tdDiscount.textContent = prod.onOffer ? `-${(prod.discount || 0)}%` : '-';
        tr.appendChild(tdDiscount);

        // Precio oferta
        const tdOfferPrice = document.createElement('td');
        const op = prod.onOffer ? calculateOfferPrice(prod.price, prod.discount) : null;
        tdOfferPrice.textContent = op ? formatPrice(op) : '-';
        tr.appendChild(tdOfferPrice);

        // Stock
        const tdStock = document.createElement('td');
        tdStock.textContent = prod.stock ?? 0;
        tr.appendChild(tdStock);

        // Estado
        const tdState = document.createElement('td');
        const stateBadge = document.createElement('span');
        stateBadge.className = 'badge-state';
        stateBadge.textContent = prod.status || 'Activo';
        tdState.appendChild(stateBadge);
        tr.appendChild(tdState);

        // Acciones
        const tdActions = document.createElement('td');
        const actions = document.createElement('div');
        actions.className = 'actions';

        // Edit
        const btnEdit = document.createElement('button');
        btnEdit.className = 'icon-btn';
        btnEdit.title = 'Editar';
        btnEdit.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25z" fill="currentColor"/><path d="M20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" fill="currentColor"/></svg>`;
        btnEdit.addEventListener('click', () => openEditProduct(prod.id));
        actions.appendChild(btnEdit);

        // Delete
        const btnDelete = document.createElement('button');
        btnDelete.className = 'icon-btn';
        btnDelete.title = 'Eliminar';
        btnDelete.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-trash" viewBox="0 0 16 16">
                                    <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0z"/>
                                    <path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4zM2.5 3h11V2h-11z"/>
                                </svg>`;
        btnDelete.addEventListener('click', () => deleteProduct(prod.id, prod.imageUrl));
        actions.appendChild(btnDelete);

        // Copy link
        const btnCopy = document.createElement('button');
        btnCopy.className = 'icon-btn';
        btnCopy.title = 'Copiar Enlace';
        btnCopy.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-link-45deg" viewBox="0 0 16 16">
                                <path d="M4.715 6.542 3.343 7.914a3 3 0 1 0 4.243 4.243l1.828-1.829A3 3 0 0 0 8.586 5.5L8 6.086a1 1 0 0 0-.154.199 2 2 0 0 1 .861 3.337L6.88 11.45a2 2 0 1 1-2.83-2.83l.793-.792a4 4 0 0 1-.128-1.287z"/>
                                <path d="M6.586 4.672A3 3 0 0 0 7.414 9.5l.775-.776a2 2 0 0 1-.896-3.346L9.12 3.55a2 2 0 1 1 2.83 2.83l-.793.792c.112.42.155.855.128 1.287l1.372-1.372a3 3 0 1 0-4.243-4.243z"/>
                            </svg>`;
        btnCopy.addEventListener('click', () => copyProductLink(prod.id));
        actions.appendChild(btnCopy);

        tdActions.appendChild(actions);
        tr.appendChild(tdActions);

        productsBody.appendChild(tr);
    });
}

/* ========== Firestore listener ========== */

const productsCol = collection(db, 'product');

function startRealtimeListener() {
    // Orden por name_lower para consistencia
    const q = query(productsCol, orderBy('name_lower', 'asc'));
    onSnapshot(q, snapshot => {
        productsLocal = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        applyFilters();
    }, err => {
        console.error('Error escuchando productos', err);
        showToast('Error cargando productos: ' + (err.message || err), 5000);
    });
}

/* ========== Filters ========== */
function applyFilters() {
    const search = (searchInput.value || '').trim().toLowerCase();
    const stateVal = stateFilter.value;
    const offerVal = offerFilter.value;

    let filtered = productsLocal.slice();

    if (search) {
        filtered = filtered.filter(p => (p.name_lower || '').includes(search));
    }
    if (stateVal) {
        filtered = filtered.filter(p => (p.status || '') === stateVal);
    }
    if (offerVal) {
        if (offerVal === 'en_oferta') filtered = filtered.filter(p => !!p.onOffer);
        if (offerVal === 'no_oferta') filtered = filtered.filter(p => !p.onOffer);
    }

    renderProducts(filtered);
}

/* ========== CRUD (con control de rol) ========== */

async function uploadImage(file, name) {
    if (!file) return null;
    const filename = `${Date.now()}_${(name || 'product').replace(/\s+/g, '_')}`;
    const ref = storageRef(storage, `products/${filename}`);
    const snapshot = await uploadBytes(ref, file);
    const url = await getDownloadURL(snapshot.ref);
    return { url, ref: snapshot.ref };
}

async function addProduct(data, file) {
    // validación de rol: solo admin puede
    if (!currentUser) { showToast('Usuario no autenticado'); return; }
    const userDoc = await getDoc(doc(db, 'users', currentUser.uid));
    if (!userDoc.exists() || userDoc.data().role !== 'administrador') {
        showToast('No autorizado: solo administradores pueden crear productos', 4000);
        return;
    }

    try {
        // subir imagen primero (opcional)
        let imageUrl = '';
        if (file) {
            const res = await uploadImage(file, data.name);
            imageUrl = res.url;
        }

        const slug = (data.name || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '');
        const newDoc = {
            name: data.name,
            name_lower: data.name.toLowerCase(),
            slug,
            description: data.description || '',
            price: Number(data.price) || 0,
            currency: 'CLP',
            category: data.category || '',
            status: data.status || 'Activo',
            onOffer: !!data.onOffer,
            discount: Number(data.discount) || 0,
            stock: Number(data.stock) || 0,
            imageUrl: imageUrl || '',
            sku: data.sku || '', // sku se genera en UI antes de enviar
            ownerId: currentUser.uid,
            salesCount: Number(data.salesCount) || 0,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        };
        await addDoc(productsCol, newDoc);
        showToast('Producto agregado con éxito');
    } catch (err) {
        console.error('addProduct error', err);
        showToast('Error al agregar producto: ' + (err.message || err), 5000);
    }
}

async function updateProduct(id, data, file, previousImageUrl, previousSku) {
    if (!currentUser) { showToast('Usuario no autenticado'); return; }
    const userDoc = await getDoc(doc(db, 'users', currentUser.uid));
    if (!userDoc.exists() || userDoc.data().role !== 'administrador') {
        showToast('No autorizado: solo administradores pueden editar productos', 4000);
        return;
    }

    try {
        let imageUrl = previousImageUrl || '';
        if (file) {
            const res = await uploadImage(file, data.name);
            imageUrl = res.url;
            // opcional: borrar imagen anterior si estaba en storage (si corresponde)
        }

        const slug = (data.name || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '');
        const docRef = doc(db, 'product', id);
        const updateData = {
            name: data.name,
            name_lower: data.name.toLowerCase(),
            slug,
            description: data.description || '',
            price: Number(data.price) || 0,
            category: data.category || '',
            status: data.status || 'Activo',
            onOffer: !!data.onOffer,
            discount: Number(data.discount) || 0,
            stock: Number(data.stock) || 0,
            imageUrl: imageUrl || '',
            sku: previousSku || data.sku || '', // PRESERVAR SKU anterior en edición
            updatedAt: serverTimestamp()
        };
        await updateDoc(docRef, updateData);
        showToast('Producto actualizado');
    } catch (err) {
        console.error('updateProduct error', err);
        showToast('Error al actualizar producto: ' + (err.message || err), 5000);
    }
}

async function deleteProduct(id, imageUrl) {
    if (!currentUser) { showToast('Usuario no autenticado'); return; }
    const userDoc = await getDoc(doc(db, 'users', currentUser.uid));
    if (!userDoc.exists() || userDoc.data().role !== 'administrador') {
        showToast('No autorizado: solo administradores pueden eliminar productos', 4000);
        return;
    }

    const ok = confirm('¿Eliminar producto? Esta acción no se puede deshacer.');
    if (!ok) return;

    try {
        await deleteDoc(doc(db, 'product', id));
        showToast('Producto eliminado');
        // opcional: eliminar imagen en storage si es una URL de storage
    } catch (err) {
        console.error('deleteProduct error', err);
        showToast('Error al eliminar producto: ' + (err.message || err), 5000);
    }
}

function buildAddLinkForPublic(productId) {
    // Construye un enlace absoluto apuntando a la página pública (index.html).
    // Si tu tienda pública está en un subpath (ej. /tienda/), cambia '/index.html' por la ruta adecuada.
    const origin = window.location.origin;
    const publicPath = '/tiendita.com/carrito.html'; // <-- Cambia esto si tu index está en otra ruta
    const params = new URLSearchParams({
        add: productId,
        openCart: '1',
        hideProducts: '1'
    });
    return `${origin}${publicPath}?${params.toString()}`;
}

async function copyProductLink(id) {
    const link = buildAddLinkForPublic(id);

    // Intentamos usar navigator.clipboard (más moderno) con fallback a textarea
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(link);
        } else {
            // fallback antiguo
            const ta = document.createElement('textarea');
            ta.value = link;
            // Asegurar estilo para no mostrar
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            document.execCommand('copy');
            ta.remove();
        }
        showToast('Enlace copiado al portapapeles');
    } catch (err) {
        console.error('copy error', err);
        showToast('No se pudo copiar enlace');
    }
}

/* ========== Modal y formulario ========= */

// Genera SKU en UI cuando cambia la categoría (solo para creación)
categoryField.addEventListener('change', () => {
    // si estamos editando, NO regenerar el SKU (preservar)
    if (isEditing) return;

    const cat = categoryField.value;
    if (!cat) {
        skuField.value = '';
        skuField.placeholder = 'Se generará al seleccionar categoría';
        return;
    }
    const sku = generateSKUForCategory(cat);
    skuField.value = sku;
});

// Abrir modal para agregar
function openAddModal() {
    isEditing = false;
    editingId = null;
    prevImageUrl = '';
    prevSku = '';
    modalTitle.textContent = 'Agregar Producto';
    productForm.reset();
    productIdField.value = '';
    skuField.value = '';
    skuField.placeholder = 'Se generará al seleccionar categoría';
    productModal.classList.remove('hidden');
    productModal.setAttribute('aria-hidden', 'false');
}

// Abrir modal para editar (preservar SKU)
async function openEditProduct(id) {
    try {
        const snap = await getDoc(doc(db, 'product', id));
        if (!snap.exists()) {
            showToast('Producto no encontrado');
            return;
        }
        const prod = { id: snap.id, ...snap.data() };
        isEditing = true;
        editingId = id;
        prevImageUrl = prod.imageUrl || '';
        prevSku = prod.sku || '';
        modalTitle.textContent = 'Editar Producto';
        productIdField.value = id;
        nameField.value = prod.name || '';
        descriptionField.value = prod.description || '';
        priceField.value = prod.price || 0;
        categoryField.value = prod.category || '';
        statusField.value = prod.status || 'Activo';
        onOfferField.checked = !!prod.onOffer;
        discountField.value = prod.discount || 0;
        stockField.value = prod.stock || 0;
        skuField.value = prod.sku || '';
        imageFileField.value = '';
        productModal.classList.remove('hidden');
        productModal.setAttribute('aria-hidden', 'false');
    } catch (err) {
        console.error('openEdit error', err);
        showToast('Error abriendo producto: ' + (err.message || err), 4000);
    }
}

function closeModal() {
    productModal.classList.add('hidden');
    productModal.setAttribute('aria-hidden', 'true');
    productForm.reset();
}

/* Form submit */
productForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = nameField.value.trim();
    const price = priceField.value;
    const category = categoryField.value;
    if (!name) { showToast('El nombre es requerido'); return; }
    if (!category) { showToast('La categoría es requerida'); return; }
    if (price === '' || Number(price) < 0) { showToast('Precio inválido'); return; }

    // Si no hay sku en creación, generar antes de enviar (por si el usuario creó y no tocó category)
    if (!isEditing && !skuField.value) {
        skuField.value = generateSKUForCategory(category);
    }

    const data = {
        name,
        description: descriptionField.value.trim(),
        price: Number(price),
        category,
        status: statusField.value,
        onOffer: onOfferField.checked,
        discount: Number(discountField.value) || 0,
        stock: Number(stockField.value) || 0,
        sku: skuField.value || ''
    };
    const file = imageFileField.files[0] || null;

    if (isEditing && editingId) {
        // get previous imageUrl to pass along (optional)
        const docSnap = await getDoc(doc(db, 'product', editingId));
        const prev = docSnap.exists() ? docSnap.data().imageUrl : '';
        await updateProduct(editingId, data, file, prev, prevSku);
    } else {
        await addProduct(data, file);
    }

    closeModal();
});

/* Events */
openAddBtn.addEventListener('click', openAddModal);
closeModalBtn.addEventListener('click', closeModal);
cancelBtn.addEventListener('click', closeModal);
searchInput.addEventListener('input', applyFilters);
stateFilter.addEventListener('change', applyFilters);
offerFilter.addEventListener('change', applyFilters);

/* ========== Auth state and start ========== */

onAuthStateChanged(auth, user => {
    if (!user) {
        // auth-guard.js should already redirect; si no, redirigir por seguridad
        window.location.href = new URL('../index.html', window.location.href).toString();
        return;
    }
    currentUser = user;
    // comprobar rol: solo seguir si admin; auth-guard ya lo hace, pero reforzamos aquí
    getDoc(doc(db, 'users', user.uid)).then(snap => {
        const role = (snap.exists() && snap.data().role) ? snap.data().role : 'vendedor';
        if (role !== 'administrador') {
            // redirigir según rol
            const ROLE_ROUTES = {
                vendedor: '../vendedor.html',
                motorizado: '../motorizado.html',
                administrador: '' // no redirige
            };
            const dest = ROLE_ROUTES[role] || '../index.html';
            window.location.href = new URL(dest, window.location.href).toString();
        } else {
            // iniciar escucha cuando confirmamos admin
            startRealtimeListener();
        }
    }).catch(err => {
        console.error('Error verificando rol en product-admin', err);
        window.location.href = new URL('../index.html', window.location.href).toString();
    });
});