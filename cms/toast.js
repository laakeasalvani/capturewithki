// The CMS's one feedback channel, extracted from edit-text.js so every module
// can reach it. The testimonial flow in particular had six ways to silently do
// nothing and no way to say so, which is what taught Khiara to keep retrying.
//
// Pass ms = 0 to hold the message until hideToast() — an upload on a phone can
// run far longer than the default.
export function showToast(message, ms) {
  let toast = document.getElementById('cmsToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'cmsToast';
    toast.className = 'cms-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toast.__timer);
  const duration = typeof ms === 'number' ? ms : 1500;
  if (duration > 0) {
    toast.__timer = setTimeout(function () { toast.classList.remove('show'); }, duration);
  }
}

export function hideToast() {
  const toast = document.getElementById('cmsToast');
  if (!toast) return;
  clearTimeout(toast.__timer);
  toast.classList.remove('show');
}
