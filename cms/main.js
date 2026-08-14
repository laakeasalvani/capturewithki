import { initAuth, login, logout, isAdmin, onAdminChange, isEditing, setEditing, onEditingChange } from './auth.js';
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
    if (isAdmin()) { setEditing(!isEditing()); return; }
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

  const badgeText = document.getElementById('cmsBadgeText');

  onAdminChange(function (active) {
    // Badge visible whenever signed in, so Log out is always reachable.
    badge.classList.toggle('visible', active);
  });

  onEditingChange(function (on) {
    gear.classList.toggle('cms-admin', on);
    badgeText.textContent = on
      ? 'Edit mode is on'
      : 'Signed in — click the gear to edit';
  });

  // The CMS has now set the real photo sources, but setting a src is not the
  // same as the photo being on screen — a 2MB upload can still be a second or
  // two from arriving. Lifting the guard at that moment reveals whatever the
  // browser already has in cache, which is the OLD photo. So wait for the
  // visible hero image to genuinely finish loading before revealing anything.
  await revealWhenHeroIsReady();

  async function revealWhenHeroIsReady() {
    const img = document.querySelector('.hero .slide.on img');
    const done = function () {
      document.documentElement.classList.remove('cms-pending');
    };

    // Nothing to wait for, or it is already decoded.
    if (!img || (img.complete && img.naturalWidth > 0)) { done(); return; }

    await new Promise(function (resolve) {
      let settled = false;
      const finish = function () { if (!settled) { settled = true; resolve(); } };
      // 'error' resolves too: a broken photo should still reveal the page
      // rather than leave a visitor staring at an empty hero.
      img.addEventListener('load', finish, { once: true });
      img.addEventListener('error', finish, { once: true });
      // Cap the wait so a stalled download cannot hold the page hostage.
      setTimeout(finish, 8000);
    });
    done();
  }
})();
