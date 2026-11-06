// ==========================================================================
// NETRON — shared site behaviour (all pages)
// ==========================================================================
'use strict';

(function () {
    function initHeaderScroll() {
        const header = document.getElementById('header');
        if (!header) return;
        const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 40);
        window.addEventListener('scroll', onScroll, { passive: true });
        onScroll();
    }

    function initBurger() {
        const burger = document.getElementById('navBurger');
        const menu = document.getElementById('navMobile');
        if (!burger || !menu) return;
        burger.addEventListener('click', () => {
            const open = menu.classList.toggle('open');
            burger.setAttribute('aria-expanded', String(open));
        });
        // close after navigating
        menu.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => {
            menu.classList.remove('open');
            burger.setAttribute('aria-expanded', 'false');
        }));
    }

    function initYear() {
        document.querySelectorAll('.js-year').forEach((el) => { el.textContent = String(new Date().getFullYear()); });
    }

    document.addEventListener('DOMContentLoaded', () => {
        initHeaderScroll();
        initBurger();
        initYear();
    });
})();
