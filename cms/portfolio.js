import { loadCollection, seedCollection, addCollectionItem, deleteCollectionItem, reorderCollection, updateCollectionItem } from './collection-store.js';
import { makeCollectionEditable } from './collection-ui.js';
import { uploadImage } from './edit-image.js';
import { onAdminChange } from './auth.js';

const COLLECTION = 'portfolioShots';
const FALLBACK = [
  { src: 'images/kiss-windy.jpg', cat: 'portraits', place: 'Honolulu, Oʻahu' },
  { src: 'images/maternity-beach.jpg', cat: 'portraits', place: 'Waimānalo' },
  { src: 'images/wedding-carry.jpg', cat: 'weddings', place: 'Kualoa Ranch' },
  { src: 'images/couple-park.jpg', cat: 'portraits', place: 'Pacific Northwest' },
  { src: 'images/gallery-a.jpg', cat: 'portraits', place: 'North Shore' },
  { src: 'images/gallery-b.jpg', cat: 'portraits', place: 'Waimānalo' },
  { src: 'images/gallery-c.jpg', cat: 'portraits', place: 'Lanikai' },
  { src: 'images/gallery-d.jpg', cat: 'portraits', place: 'Kāhala' },
  { src: 'images/gallery-e.jpg', cat: 'portraits', place: 'North Shore' },
  { src: 'images/gallery-f.jpg', cat: 'portraits', place: 'Waimānalo' },
  { src: 'images/gallery-g.jpg', cat: 'portraits', place: 'Waimānalo' },
  { src: 'images/gallery-h.jpg', cat: 'portraits', place: 'Lanikai' },
  { src: 'images/gallery-i.jpg', cat: 'portraits', place: 'Honolulu, Oʻahu' },
  { src: 'images/grid-01.jpg', cat: 'portraits', place: 'Kāhala' },
  { src: 'images/grid-02-wide.jpg', cat: 'portraits', place: 'Kāhala', wide: true },
  { src: 'images/grid-03.jpg', cat: 'portraits', place: 'North Shore' },
  { src: 'images/grid-04.jpg', cat: 'portraits', place: 'North Shore' },
  { src: 'images/grid-05.jpg', cat: 'portraits', place: 'North Shore' },
  { src: 'images/grid-06-wide.jpg', cat: 'portraits', place: 'Pacific Northwest', wide: true },
  { src: 'images/grid-07.jpg', cat: 'portraits', place: 'Honolulu, Oʻahu' },
  { src: 'images/grid-08.jpg', cat: 'portraits', place: 'Honolulu, Oʻahu' },
  { src: 'images/grid-09.jpg', cat: 'weddings', place: 'Kualoa Ranch' },
  { src: 'images/grid-10.jpg', cat: 'portraits', place: 'Kāhala' },
  { src: 'images/grid-11.jpg', cat: 'portraits', place: 'Waimānalo', wide: true },
  { src: 'images/grid-12.jpg', cat: 'portraits', place: 'Pacific Northwest' },
  { src: 'images/about-bio.jpg', cat: 'portraits', place: 'North Shore' },
  { src: 'images/about-bio-2.jpg', cat: 'portraits', place: 'Pacific Northwest' },
  { src: 'images/about-banner.jpg', cat: 'portraits', place: 'Pacific Northwest' },
  { src: 'images/contact-photo.jpg', cat: 'elopements', place: 'Kualoa Ranch' },
  { src: 'images/home-banner.jpg', cat: 'portraits', place: 'Pacific Northwest' },
  { src: 'images/portfolio-banner.jpg', cat: 'elopements', place: 'Kualoa Ranch', wide: true },
  { src: 'images/pricing-hero.jpg', cat: 'portraits', place: 'Waimānalo' },
  { src: 'images/pricing-portraits.jpg', cat: 'portraits', place: 'Kualoa Ranch' },
  { src: 'images/pricing-elopements.jpg', cat: 'portraits', place: 'Kāhala' },
  { src: 'images/pricing-weddings-banner.jpg', cat: 'weddings', place: 'Kualoa Ranch', wide: true },
  { src: 'images/pricing-final-banner.jpg', cat: 'portraits', place: 'Pacific Northwest' }
];

let items = [];
let usingFallback = true;

const grid = document.getElementById('grid');
const filmstripTrack = document.getElementById('filmstripTrack');

// Exactly one instance: the drag state lives in its closure and must be
// shared by every tile, or dragover on a different tile sees a null dragEl.
const ui = makeCollectionEditable({
  onAdd: handleAdd,
  onDelete: handleDelete,
  onReorder: handleReorder,
  onSwap: handleSwap
});

function renderGrid() {
  grid.innerHTML = '';
  items.forEach(function (item) {
    const tile = document.createElement('div');
    tile.className = 'shot' + (item.wide ? ' wide' : '');
    tile.innerHTML = '<div class="frame marked"><img loading="lazy" alt="" src="' + item.src + '"></div>';
    grid.appendChild(tile);
    if (!usingFallback) ui.attachTile(tile, item.id);
  });

  if (!usingFallback) {
    const addTile = ui.buildAddTile();
    addTile.classList.add('shot');
    grid.appendChild(addTile);
  }
}

function renderFilmstrip() {
  filmstripTrack.innerHTML = '';
  const first9 = items.slice(0, 9);
  if (!first9.length) return;
  // Duplicated once so the auto-scroll can loop seamlessly.
  first9.concat(first9).forEach(function (item, i) {
    const frame = document.createElement('div');
    frame.className = 'frame marked';
    if (i >= first9.length) frame.setAttribute('aria-hidden', 'true');
    frame.innerHTML = '<img src="' + item.src + '" alt="">';
    filmstripTrack.appendChild(frame);
  });
}

function render() {
  renderGrid();
  renderFilmstrip();
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
      const url = await uploadImage(file, 'portfolioShots');
      items = await loadCollection(COLLECTION);
      await addCollectionItem(COLLECTION, { src: url, cat: 'portraits', place: '' }, items.length);
      await refresh();
    } catch (err) {
      alert('Could not add that photo: ' + (err && (err.code || err.message)));
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
    alert('Could not delete that photo: ' + (err && (err.code || err.message)));
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
      const url = await uploadImage(file, 'portfolioShots');
      await updateCollectionItem(COLLECTION, id, { src: url });
      await refresh();
    } catch (err) {
      alert('Could not swap that photo: ' + (err && (err.code || err.message)));
      await refresh();
    }
  });
  input.click();
}

export async function initPortfolio() {
  const loaded = await loadCollection(COLLECTION);
  if (loaded.length > 0) {
    items = loaded;
    usingFallback = false;
  } else {
    items = FALLBACK;
    usingFallback = true;
  }
  render();

  onAdminChange(async function (active) {
    if (active) {
      try {
        await ensureSeeded();
      } catch (err) {
        alert('Could not prepare the portfolio for editing: ' + (err && (err.code || err.message)));
      }
    }
    grid.classList.toggle('cms-editmode', active);
  });
}
