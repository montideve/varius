import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import { getFirestore, collection, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

const ordersTodayEl = document.getElementById('kpi-orders-today');
const salesEl = document.getElementById('kpi-sales');

function startOfTodayLocal() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
}
function formatMoney(n) {
    try { return Number(n || 0).toLocaleString(); } catch (e) { return String(n || 0); }
}

onAuthStateChanged(auth, (user) => {
    if (!user) return;
    // Suscribimos solo a orders donde assignedSeller == user.uid
    const ordersCol = collection(db, 'orders');
    const q = query(ordersCol, where('assignedSeller', '==', user.uid));
    onSnapshot(q, (snapshot) => {
        const todayStart = startOfTodayLocal();
        let ordersToday = 0;
        let salesToday = 0;
        snapshot.docs.forEach(docSnap => {
            const data = docSnap.data();
            // determinar fecha de pedido (varias posibilidades)
            let d = null;
            if (data.createdAt && typeof data.createdAt.toDate === 'function') d = data.createdAt.toDate();
            else if (data.orderDate) d = (data.orderDate.toDate ? data.orderDate.toDate() : new Date(data.orderDate));
            if (d && d >= todayStart) {
                ordersToday++;
                // sumar total del pedido
                let total = 0;
                if (typeof data.total === 'number') total = data.total;
                else if (typeof data.amount === 'number') total = data.amount;
                else if (data.items && Array.isArray(data.items)) {
                    total = data.items.reduce((acc, it) => {
                        const p = Number(it.price || 0), q = Number(it.quantity || it.qty || 1);
                        return acc + (p * q);
                    }, 0);
                }
                salesToday += (total || 0);
            }
        });
        if (ordersTodayEl) ordersTodayEl.textContent = ordersToday;
        if (salesEl) salesEl.textContent = formatMoney(salesToday);
    }, err => {
        console.error('KPIs snapshot error:', err);
        if (ordersTodayEl) ordersTodayEl.textContent = '—';
        if (salesEl) salesEl.textContent = '—';
    });
});