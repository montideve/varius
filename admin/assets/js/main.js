document.addEventListener('DOMContentLoaded', function () {
    const menuToggle = document.getElementById('menuToggle');
    const sidebar = document.getElementById('sidebar');
    const navItems = document.querySelectorAll('.nav-item');

    menuToggle.addEventListener('click', function () {
        sidebar.classList.toggle('active');
    });

    navItems.forEach(item => {
        item.addEventListener('click', function (e) {
            if (this.classList.contains('has-submenu')) {
                e.preventDefault();
                this.classList.toggle('active');
                return;
            }

            const href = this.getAttribute('href');
            if (!href || href === '#') return;

            e.preventDefault();

            navItems.forEach(nav => {
                if (!nav.classList.contains('has-submenu')) {
                    nav.classList.remove('active');
                }
            });

            this.classList.add('active');

            const pageId = href.substring(1) + '-page';
            const pages = document.querySelectorAll('.page-content');

            pages.forEach(page => {
                page.classList.add('hidden');
            });

            const targetPage = document.getElementById(pageId);

            if (targetPage) {
                targetPage.classList.remove('hidden');
            }

            if (window.innerWidth <= 768) {
                sidebar.classList.remove('active');
            }
        });
    });

    const submenuItems = document.querySelectorAll('.submenu-item');

    submenuItems.forEach(item => {
        item.addEventListener('click', function (e) {
            e.preventDefault();

            navItems.forEach(nav => {
                if (!nav.classList.contains('has-submenu')) {
                    nav.classList.remove('active');
                }
            });

            submenuItems.forEach(sub => {
                sub.classList.remove('active');
            });

            this.classList.add('active');

            const href = this.getAttribute('href');
            const pageId = href.substring(1) + '-page';
            const pages = document.querySelectorAll('.page-content');

            pages.forEach(page => {
                page.classList.add('hidden');
            });

            const targetPage = document.getElementById(pageId);

            if (targetPage) {
                targetPage.classList.remove('hidden');
            }

            if (window.innerWidth <= 768) {
                sidebar.classList.remove('active');
            }
        });
    });

    document.addEventListener('click', function (e) {
        if (window.innerWidth <= 768) {
            if (!sidebar.contains(e.target) && !menuToggle.contains(e.target)) {
                sidebar.classList.remove('active');
            }
        }
    });
});