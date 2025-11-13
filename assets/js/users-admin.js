// admin-users.js
// Manejo del modal de usuarios (crear / editar) y renderizado básico de la lista.
// Requiere Firebase v12 (mismas urls que auth.js).

import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import {
    getAuth,
    onAuthStateChanged,
    createUserWithEmailAndPassword,
    sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import {
    getFirestore,
    collection,
    getDocs,
    getDoc,
    doc,
    setDoc,
    updateDoc,
    deleteDoc,
    serverTimestamp,
    query,
    orderBy
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";

// Inicializa Firebase (solo si no está)
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// DOM
const openAddBtn = document.getElementById('openAddBtn');
const userModal = document.getElementById('userModal');
const closeModalBtn = document.getElementById('closeModal');
const userForm = document.getElementById('userForm');
const cancelBtn = document.getElementById('cancelBtn');
const toastEl = document.getElementById('toast');
const usersBody = document.getElementById('usersBody');

const searchInput = document.getElementById('searchInput');
const roleFilter = document.getElementById('roleFilter');
const statusFilter = document.getElementById('statusFilter');
const perPageSelect = document.getElementById('perPageSelect');
const prevPageBtn = document.getElementById('prevPage');
const nextPageBtn = document.getElementById('nextPage');
const pageInfo = document.getElementById('pageInfo');

let allUsers = []; // cache
let filteredUsers = [];
let currentPage = 1;

// Helper: Toast
function showToast(msg, time = 2500) {
    if (!toastEl) {
        console.log('Toast:', msg);
        return;
    }
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    setTimeout(() => {
        toastEl.classList.add('hidden');
    }, time);
}

// Modal helpers
function openModal(mode = 'add', data = null) {
    const titleEl = document.getElementById('modalTitle');
    const userIdEl = document.getElementById('userId');

    titleEl.textContent = mode === 'add' ? 'Agregar Usuario' : 'Editar Usuario';
    userIdEl.value = data && data.id ? data.id : '';

    // Populate fields if edit
    document.getElementById('u_name').value = data?.name || '';
    document.getElementById('u_email').value = data?.email || '';
    document.getElementById('u_phone').value = data?.phone || '';
    document.getElementById('u_role').value = data?.role || '';
    document.getElementById('u_status').value = data?.status || 'Activo';
    // Clear password fields always
    document.getElementById('u_password').value = '';
    document.getElementById('u_password_confirm').value = '';

    userModal.classList.remove('hidden');
    userModal.setAttribute('aria-hidden', 'false');
}

function closeModal() {
    userModal.classList.add('hidden');
    userModal.setAttribute('aria-hidden', 'true');
    // Clear inline alerts
    ['u_name_alert', 'u_email_alert', 'u_password_alert', 'u_password_confirm_alert'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = '';
    });
}

// Validación simple de formulario
function validateForm(values, isEdit = false) {
    // values: {name,email,phone,role,status,password,confirm}
    let ok = true;
    // name
    if (!values.name || !values.name.trim()) {
        document.getElementById('u_name_alert').textContent = 'El nombre es requerido.';
        ok = false;
    } else {
        document.getElementById('u_name_alert').textContent = '';
    }
    // email
    if (!values.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
        document.getElementById('u_email_alert').textContent = 'Correo inválido.';
        ok = false;
    } else {
        document.getElementById('u_email_alert').textContent = '';
    }
    // role
    if (!values.role) {
        // role is required in modal (select has required in markup)
        // but we still check
        ok = false;
        // We don't have role_alert element; you can add UI if desired
    }

    // Password: only required when adding a user.
    if (!isEdit || (values.password || values.confirm)) {
        const pw = values.password || '';
        const confirm = values.confirm || '';
        // length 6-8 (modal uses minlength=6 maxlength=8)
        const okLen = pw.length >= 6 && pw.length <= 8;
        const okUpper = /[A-Z]/.test(pw);
        const okLower = /[a-z]/.test(pw);
        const okNumber = /[0-9]/.test(pw);
        const okSpecial = /[\W_]/.test(pw);
        if (!okLen || !okUpper || !okLower || !okNumber || !okSpecial) {
            document.getElementById('u_password_alert').textContent =
                'La contraseña debe tener 6-8 caracteres e incluir mayúscula, minúscula, número y carácter especial.';
            ok = false;
        } else {
            document.getElementById('u_password_alert').textContent = '';
        }
        if (pw !== confirm) {
            document.getElementById('u_password_confirm_alert').textContent = 'Las contraseñas no coinciden.';
            ok = false;
        } else {
            document.getElementById('u_password_confirm_alert').textContent = '';
        }
    } else {
        // clear password alerts when not provided
        document.getElementById('u_password_alert').textContent = '';
        document.getElementById('u_password_confirm_alert').textContent = '';
    }

    return ok;
}

// Load users from Firestore
async function loadUsers() {
    try {
        const q = query(collection(db, 'users'), orderBy('createdAt', 'desc'));
        const snap = await getDocs(q);
        allUsers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        applyFiltersAndRender();
    } catch (err) {
        console.error('Error loading users:', err);
        showToast('Error cargando usuarios.');
    }
}

// Render table with pagination & filters
function applyFiltersAndRender() {
    const q = searchInput?.value?.toLowerCase() || '';
    const role = roleFilter?.value || '';
    const status = statusFilter?.value || '';

    filteredUsers = allUsers.filter(u => {
        const matchesQ = !q || ((u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q));
        const matchesRole = !role || (u.role === role);
        const matchesStatus = !status || (u.status === status);
        return matchesQ && matchesRole && matchesStatus;
    });

    renderTable();
}

function renderTable() {
    // Pagination
    const perPageVal = perPageSelect?.value || '10';
    let perPage = perPageVal === 'all' ? filteredUsers.length || 1 : parseInt(perPageVal, 10);
    const total = filteredUsers.length;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    if (currentPage > totalPages) currentPage = totalPages;

    const start = (currentPage - 1) * perPage;
    const pageItems = filteredUsers.slice(start, start + perPage);

    // Update page info
    if (pageInfo) pageInfo.textContent = `${total ? start + 1 : 0}-${Math.min(start + perPage, total)} de ${total}`;

    // Render rows
    usersBody.innerHTML = '';
    for (const u of pageItems) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
        <td>${escapeHtml(u.name || '')}</td>
        <td>${escapeHtml(u.email || '')}</td>
        <td><span class="badge-state">${escapeHtml(u.role || '')}</span></td>
        <td>${escapeHtml(u.phone || '')}</td>
        <td><span class="badge-state">${escapeHtml(u.status || '')}</span></td>
        <td>
            <div class="actions">
                <button class="icon-btn btn-edit" data-id="${u.id}" title="Editar">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                        <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25z" fill="currentColor"/>
                        <path d="M20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" fill="currentColor"/>
                    </svg>
                </button>
                <button class="icon-btn btn-delete" data-id="${u.id}" title="Eliminar">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-trash" viewBox="0 0 16 16">
                        <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0z"/>
                        <path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4zM2.5 3h11V2h-11z"/>
                    </svg>
                </button>
            </div>
        </td>
    `;
        usersBody.appendChild(tr);
    }
    // reseteo de clave <button class="icon-btn btn-send-reset" data-email="${escapeHtmlAttr(u.email)}">Enviar reset</button>
    // Attach listeners for buttons
    usersBody.querySelectorAll('.btn-edit').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const id = e.currentTarget.getAttribute('data-id');
            const docSnap = allUsers.find(x => x.id === id);
            if (docSnap) {
                openModal('edit', docSnap);
            } else {
                // fallback: fetch single
                const d = await getDoc(doc(db, 'users', id));
                if (d.exists()) openModal('edit', { id: d.id, ...d.data() });
            }
        });
    });

    usersBody.querySelectorAll('.btn-send-reset').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const email = e.currentTarget.getAttribute('data-email');
            if (!email) return;
            if (!confirm(`Enviar correo de restablecimiento a ${email}?`)) return;
            try {
                await sendPasswordResetEmail(auth, email);
                showToast('Correo de restablecimiento enviado.');
            } catch (err) {
                console.error('reset email err', err);
                showToast('Error enviando correo de restablecimiento.');
            }
        });
    });

    usersBody.querySelectorAll('.btn-delete').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const id = e.currentTarget.getAttribute('data-id');
            if (!confirm('¿Eliminar documento de usuario? Esto no borra la cuenta de Auth.')) return;
            try {
                await deleteDoc(doc(db, 'users', id));
                showToast('Usuario eliminado (doc).');
                await loadUsers();
            } catch (err) {
                console.error('Error deleting user doc', err);
                showToast('Error eliminando usuario.');
            }
        });
    });
}

// Utils
function escapeHtml(s) {
    if (!s) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
function escapeHtmlAttr(s) {
    if (!s) return '';
    return String(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Form submit - create or update
userForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const userId = document.getElementById('userId').value;
    const name = document.getElementById('u_name').value.trim();
    const email = document.getElementById('u_email').value.trim();
    const phone = document.getElementById('u_phone').value.trim();
    const role = document.getElementById('u_role').value;
    const status = document.getElementById('u_status').value;
    const password = document.getElementById('u_password').value;
    const confirm = document.getElementById('u_password_confirm').value;

    const values = { name, email, phone, role, status, password, confirm };
    const isEdit = !!userId;
    if (!validateForm(values, isEdit)) return;

    try {
        if (!isEdit) {
            // Create Auth account + firestire doc
            const cred = await createUserWithEmailAndPassword(auth, email, password);
            const uid = cred.user.uid;
            await setDoc(doc(db, 'users', uid), {
                name,
                email,
                phone,
                role,
                status: status || 'Activo',
                createdAt: serverTimestamp(),
                createdBy: auth.currentUser ? auth.currentUser.uid : null
            });
            showToast('Usuario creado correctamente.');
        } else {
            // Update Firestore doc only
            await updateDoc(doc(db, 'users', userId), {
                name,
                phone,
                role,
                status
            });
            // If admin provided password while editing, we send reset email (safer than attempting to change other's password client-side)
            if (password) {
                await sendPasswordResetEmail(auth, email);
                showToast('Datos actualizados. Se envió correo para restablecer la contraseña.');
            } else {
                showToast('Usuario actualizado.');
            }
        }
        closeModal();
        await loadUsers();
    } catch (err) {
        console.error('Error al guardar usuario:', err);
        showToast('Error guardando usuario. Revisa consola.');
    }
});

// Event listeners
openAddBtn?.addEventListener('click', () => openModal('add'));
closeModalBtn?.addEventListener('click', closeModal);
cancelBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    closeModal();
});

// Close modal on backdrop click (optional)
userModal?.addEventListener('click', (e) => {
    if (e.target === userModal) closeModal();
});

// Filters & pagination events
searchInput?.addEventListener('input', () => { currentPage = 1; applyFiltersAndRender(); });
roleFilter?.addEventListener('change', () => { currentPage = 1; applyFiltersAndRender(); });
statusFilter?.addEventListener('change', () => { currentPage = 1; applyFiltersAndRender(); });
perPageSelect?.addEventListener('change', () => { currentPage = 1; renderTable(); });
prevPageBtn?.addEventListener('click', () => { if (currentPage > 1) { currentPage--; renderTable(); } });
nextPageBtn?.addEventListener('click', () => {
    const perPageVal = perPageSelect?.value || '10';
    let perPage = perPageVal === 'all' ? filteredUsers.length || 1 : parseInt(perPageVal, 10);
    const totalPages = Math.max(1, Math.ceil(filteredUsers.length / perPage));
    if (currentPage < totalPages) currentPage++;
    renderTable();
});

// Require admin: redirect if current user is not administrador (optional)
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        // not logged in -> redirect to index
        window.location.href = '/index.html';
        return;
    }
    // check role in users collection
    try {
        const snap = await getDoc(doc(db, 'users', user.uid));
        if (snap.exists()) {
            const role = snap.data().role;
            if (role !== 'administrador') {
                // non-admin users may be redirected or shown limited view
                // For safety we redirect to role route
                window.location.href = `/admin/${role}.html`;
                return;
            }
            // load user list
            await loadUsers();
        } else {
            // if no doc, redirect to default role page
            window.location.href = '/index.html';
        }
    } catch (err) {
        console.error('Error comprobando role:', err);
        await loadUsers(); // try loading anyway
    }
});