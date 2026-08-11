import { initAuth, login, logout, isAdmin, onAdminChange } from './auth.js';
import { loadSiteContent } from './content-store.js';
import { initTextEditing } from './edit-text.js';
import { initImageEditing } from './edit-image.js';
import { initHero } from './hero.js';
import { initPortfolio } from './portfolio.js';
import { initFilmstrip } from './filmstrip.js';
import { initTestimonials } from './testimonials.js';

(async function () {
  await loadSiteContent();
  initTextEditing();
  initImageEditing();
  await initHero();
  await initPortfolio();
  await initFilmstrip();
  await initTestimonials();
  initAuth();

  const gear = document.getElementById('cmsGear');
  const modal = document.getElementById('cmsModalBackdrop');
  const form = document.getElementById('cmsLoginForm');
  const errorEl = document.getElementById('cmsLoginError');
  const badge = document.getElementById('cmsEditBadge');
  const logoutBtn = document.getElementById('cmsLogoutBtn');

  gear.addEventListener('click', function () {
    if (isAdmin()) return;
    modal.classList.add('open');
  });

  document.getElementById('cmsModalClose').addEventListener('click', function () {
    modal.classList.remove('open');
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errorEl.textContent = '';
    const email = document.getElementById('cmsEmail').value.trim();
    const password = document.getElementById('cmsPassword').value;
    login(email, password)
      .then(function () {
        modal.classList.remove('open');
        form.reset();
      })
      .catch(function () {
        errorEl.textContent = 'Wrong email or password.';
      });
  });

  logoutBtn.addEventListener('click', function () {
    logout();
  });

  onAdminChange(function (active) {
    gear.classList.toggle('cms-admin', active);
    badge.classList.toggle('visible', active);
  });
})();
