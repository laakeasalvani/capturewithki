import { loadCollection, seedCollection, addCollectionItem, deleteCollectionItem, reorderCollection, updateCollectionItem } from './collection-store.js';
import { uploadImage } from './edit-image.js';
import { onEditingChange } from './auth.js';
import { setCurrentItem } from './edit-text.js';

const COLLECTION = 'testimonials';
const FALLBACK = [
  { img: 'images/gallery-a.jpg', quote: 'She caught the ten seconds I was most afraid I’d forget.', who: 'Mailani & Josh' },
  { img: 'images/grid-03.jpg', quote: 'Calm the whole day. Our families still talk about how easy she made it.', who: 'Renée & Tomás' },
  { img: 'images/gallery-h.jpg', quote: 'We booked for the portfolio and stayed for the person.', who: 'Ava & Sam' },
  { img: 'images/grid-04.jpg', quote: 'It felt like hanging out with a friend who happened to have a camera.', who: 'Noa & Leilani' },
  { img: 'images/grid-07.jpg', quote: 'Every photo looks like a memory, not a pose.', who: 'Sarah & Michael' },
  { img: 'images/grid-12.jpg', quote: 'She made my anxious, awkward-in-photos self feel completely at ease.', who: 'Jenna & Chris' }
];

let items = [];
let usingFallback = true;
let index = 0;

const llImg = document.getElementById('llImg');
const llQuote = document.getElementById('llQuote');
const llWho = document.getElementById('llWho');
const llCount = document.getElementById('llCount');
const controls = document.getElementById('cmsLLControls');

// llImg's parent (.ll-media.frame) is already position:relative via .frame,
// so the reused .cms-image-overlay button lands on the photo without any
// extra positioning.
const llMedia = llImg.parentNode;
const changePhotoBtn = document.createElement('button');
changePhotoBtn.type = 'button';
changePhotoBtn.className = 'cms-image-overlay';
changePhotoBtn.textContent = 'Change photo';
changePhotoBtn.addEventListener('click', function (e) {
  e.preventDefault();
  e.stopPropagation();
  handleChangePhoto();
});
llMedia.appendChild(changePhotoBtn);

function renderLL() {
  if (!items.length) return;
  if (index >= items.length) index = 0;
  const d = items[index];
  setCurrentItem('testimonials', d.id);
  llImg.style.opacity = 0;
  llQuote.style.opacity = 0;
  llWho.style.opacity = 0;
  setTimeout(function () {
    llImg.src = d.img;
    llQuote.textContent = d.quote;
    llWho.textContent = d.who.toUpperCase();
    llCount.textContent = (index + 1) + ' / ' + items.length;
    llImg.style.opacity = 1;
    llQuote.style.opacity = 1;
    llWho.style.opacity = 1;
  }, 200);
}

async function refresh() {
  const loaded = await loadCollection(COLLECTION);
  if (loaded.length) {
    items = loaded;
    usingFallback = false;
  }
  if (index >= items.length) index = 0;
  renderLL();
}

async function ensureSeeded() {
  if (!usingFallback) return;
  await seedCollection(COLLECTION, FALLBACK);
  items = await loadCollection(COLLECTION);
  usingFallback = false;
  renderLL();
}

async function handleAdd() {
  const quote = prompt('Quote:');
  if (!quote) return;
  const who = prompt('Names (e.g. "Mailani & Josh"):');
  if (!who) return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', async function () {
    const file = input.files[0];
    if (!file) return;
    try {
      await ensureSeeded();
      const url = await uploadImage(file, 'testimonials');
      items = await loadCollection(COLLECTION);
      await addCollectionItem(COLLECTION, { img: url, quote: quote, who: who }, items.length);
      await refresh();
      index = items.length - 1;
      renderLL();
    } catch (err) {
      alert('Could not add that testimonial: ' + (err && (err.code || err.message)));
      await refresh();
    }
  });
  input.click();
}

async function handleDelete() {
  try {
    await ensureSeeded();
    if (items.length <= 1) {
      alert('At least one testimonial is required.');
      return;
    }
    if (!confirm('Delete this testimonial?')) return;
    await deleteCollectionItem(COLLECTION, items[index].id);
    index = 0;
    await refresh();
  } catch (err) {
    alert('Could not delete that testimonial: ' + (err && (err.code || err.message)));
    await refresh();
  }
}

async function handleChangePhoto() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', async function () {
    const file = input.files[0];
    if (!file) return;
    try {
      await ensureSeeded();
      const id = items[index] && items[index].id;
      if (!id) return;
      const url = await uploadImage(file, 'testimonials');
      await updateCollectionItem('testimonials', id, { img: url });
      await refresh();
    } catch (err) {
      alert('Could not change that photo: ' + (err && (err.code || err.message)));
      await refresh();
    }
  });
  input.click();
}

async function move(delta) {
  try {
    await ensureSeeded();
    if (items.length < 2) return;
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const ids = items.map(function (it) { return it.id; });
    const moved = ids.splice(index, 1)[0];
    ids.splice(target, 0, moved);
    await reorderCollection(COLLECTION, ids);
    items = await loadCollection(COLLECTION);
    index = target;
    renderLL();
  } catch (err) {
    alert('Could not move that testimonial: ' + (err && (err.code || err.message)));
    await refresh();
  }
}

export async function initTestimonials() {
  const loaded = await loadCollection(COLLECTION);
  if (loaded.length > 0) {
    items = loaded;
    usingFallback = false;
  } else {
    items = FALLBACK;
    usingFallback = true;
  }
  renderLL();

  document.getElementById('llPrev').addEventListener('click', function () {
    index = (index - 1 + items.length) % items.length;
    renderLL();
  });
  document.getElementById('llNext').addEventListener('click', function () {
    index = (index + 1) % items.length;
    renderLL();
  });
  document.addEventListener('cms:collection-item-saved', function (e) {
    if (e.detail && e.detail.collection === COLLECTION) refresh();
  });

  document.getElementById('cmsLLAdd').addEventListener('click', handleAdd);
  document.getElementById('cmsLLDelete').addEventListener('click', handleDelete);
  document.getElementById('cmsLLMoveLeft').addEventListener('click', function () { move(-1); });
  document.getElementById('cmsLLMoveRight').addEventListener('click', function () { move(1); });

  onEditingChange(async function (active) {
    if (active) {
      try {
        await ensureSeeded();
      } catch (err) {
        alert('Could not prepare testimonials for editing: ' + (err && (err.code || err.message)));
      }
    }
    controls.style.display = active ? 'flex' : 'none';
    changePhotoBtn.classList.toggle('cms-visible', active);
  });
}
