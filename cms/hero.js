import { loadCollection, seedCollection, addCollectionItem, deleteCollectionItem, reorderCollection, updateCollectionItem } from './collection-store.js';
import { makeCollectionEditable } from './collection-ui.js';
import { uploadImage } from './edit-image.js';
import { onEditingChange } from './auth.js';

const COLLECTION = 'heroSlides';
const FALLBACK = [
  { src: 'images/elopement-mountains.jpg', alt: 'Eloping couple embracing in front of the Koʻolau mountains', objectPosition: '50% 58%' },
  { src: 'images/maternity-walk.jpg', alt: 'Pregnant couple holding hands while walking on the beach', objectPosition: '40% 45%' },
  { src: 'images/park-embrace.jpg', alt: 'Couple embracing in a sunlit park', objectPosition: '50% 35%' },
  { src: 'images/family-palm.jpg', alt: 'Family of four sitting on the beach under a palm tree', objectPosition: '50% 55%' }
];

let items = [];
let usingFallback = true;
let index = 0;
let timer;

const mount = document.getElementById('heroSlides');
const framesEl = document.getElementById('frames');
const counter = document.getElementById('counter');

const ui = makeCollectionEditable({
  onAdd: handleAdd,
  onDelete: handleDelete,
  onReorder: handleReorder,
  onSwap: handleSwap
});

function render() {
  mount.innerHTML = '';
  framesEl.innerHTML = '';

  items.forEach(function (item, i) {
    const slide = document.createElement('div');
    slide.className = 'slide';
    const img = document.createElement('img');
    img.src = item.src;
    img.alt = item.alt || '';
    img.style.objectPosition = item.objectPosition || '50% 50%';
    slide.appendChild(img);
    mount.appendChild(slide);

    // Slides are absolutely positioned and stacked, so the thumbnail is the
    // only visible handle for reordering or deleting a slide.
    const holder = document.createElement('div');
    holder.className = 'cms-hero-thumb';

    const thumb = document.createElement('button');
    thumb.type = 'button';
    thumb.setAttribute('aria-label', 'Frame ' + (i + 1));
    thumb.innerHTML = '<img alt="" src="' + item.src + '">';
    thumb.addEventListener('click', function () { show(i); auto(); });
    holder.appendChild(thumb);
    framesEl.appendChild(holder);

    if (!usingFallback) ui.attachTile(holder, item.id);
  });

  if (!usingFallback) framesEl.appendChild(ui.buildAddTile());

  show(0);
  auto();
}

function show(n) {
  const slides = mount.querySelectorAll('.slide');
  const thumbs = framesEl.querySelectorAll('.cms-hero-thumb > button');
  if (!slides.length) { counter.textContent = 'No slides'; return; }
  index = (n + slides.length) % slides.length;
  slides.forEach(function (s, k) { s.classList.toggle('on', k === index); });
  thumbs.forEach(function (t, k) { t.classList.toggle('on', k === index); });
  counter.textContent = 'Frame ' + String(index + 1).padStart(2, '0');
}

function auto() {
  clearInterval(timer);
  timer = setInterval(function () { show(index + 1); }, 6800);
}

async function refresh() {
  items = await loadCollection(COLLECTION);
  render();
}

async function ensureSeeded() {
  if (!usingFallback) return;
  await seedCollection(COLLECTION, FALLBACK);
  items = await loadCollection(COLLECTION);
  usingFallback = false;
  render();
}

async function handleAdd() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', async function () {
    const file = input.files[0];
    if (!file) return;
    try {
      await ensureSeeded();
      const url = await uploadImage(file, 'heroSlides');
      items = await loadCollection(COLLECTION);
      await addCollectionItem(COLLECTION, { src: url, alt: '', objectPosition: '50% 50%' }, items.length);
      await refresh();
    } catch (err) {
      alert('Could not add that slide: ' + (err && (err.code || err.message)));
      await refresh();
    }
  });
  input.click();
}

async function handleDelete(id) {
  try {
    await deleteCollectionItem(COLLECTION, id);
    await refresh();
  } catch (err) {
    alert('Could not delete that slide: ' + (err && (err.code || err.message)));
    await refresh();
  }
}

async function handleReorder(orderedIds) {
  try {
    await reorderCollection(COLLECTION, orderedIds);
    await refresh();
  } catch (err) {
    alert('Could not save the new order: ' + (err && (err.code || err.message)));
    await refresh();
  }
}

function handleSwap(id) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', async function () {
    const file = input.files[0];
    if (!file) return;
    try {
      const url = await uploadImage(file, 'heroSlides');
      await updateCollectionItem(COLLECTION, id, { src: url });
      await refresh();
    } catch (err) {
      alert('Could not swap that photo: ' + (err && (err.code || err.message)));
      await refresh();
    }
  });
  input.click();
}

export async function initHero() {
  const loaded = await loadCollection(COLLECTION);
  if (loaded.length > 0) {
    items = loaded;
    usingFallback = false;
  } else {
    items = FALLBACK;
    usingFallback = true;
  }
  render();

  document.getElementById('prev').addEventListener('click', function () { show(index - 1); auto(); });
  document.getElementById('next').addEventListener('click', function () { show(index + 1); auto(); });

  onEditingChange(async function (active) {
    if (active) {
      try {
        await ensureSeeded();
      } catch (err) {
        alert('Could not prepare the slideshow for editing: ' + (err && (err.code || err.message)));
      }
    }
    framesEl.classList.toggle('cms-editmode', active);
  });
}
