import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import { getFirestore, collection, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

const deliveredEl = document.getElementById('kpi-delivered');
const deliveredTodayEl = document.getElementById('kpi-delivered-today');
const assignedEl = document.getElementById('kpi-assigned');

function startOfTodayLocal() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
}

onAuthStateChanged(auth, (user) => {
    if (!user) return;
    const ordersCol = collection(db, 'orders');
    const q = query(ordersCol, where('assignedMotor', '==', user.uid));
    onSnapshot(q, (snapshot) => {
        let totalDelivered = 0;
        let deliveredToday = 0;
        let assignedCount = 0;
        const todayStart = startOfTodayLocal();
        snapshot.docs.forEach(docSnap => {
            const data = docSnap.data();
            assignedCount++;
            const status = (data.shippingStatus || data.status || '').toString().toLowerCase();
            if (status === 'entregado' || status === 'delivered') {
                totalDelivered++;
                const deliveredAt = (data.deliveredAt && typeof data.deliveredAt.toDate === 'function') ? data.deliveredAt.toDate() : (data.shippingUpdatedAt && typeof data.shippingUpdatedAt.toDate === 'function' ? data.shippingUpdatedAt.toDate() : null);
                if (deliveredAt && deliveredAt >= todayStart) deliveredToday++;
            }
        });
        if (deliveredEl) deliveredEl.textContent = String(totalDelivered);
        if (deliveredTodayEl) deliveredTodayEl.textContent = String(deliveredToday);
        if (assignedEl) assignedEl.textContent = String(assignedCount);
    }, err => {
        console.error('KPIs snapshot error:', err);
        if (deliveredEl) deliveredEl.textContent = '—';
        if (deliveredTodayEl) deliveredTodayEl.textContent = '—';
        if (assignedEl) assignedEl.textContent = '—';
    });
});