//
// Pure and browser-safe — int/contracts.js imports this to validate before saving,
// the same way it imports contracts.js. No node-only modules.

export const TEMPLATE_KEYS = ['wedding', 'elopement', 'portrait'];

const SPECS = {
  wedding:   ['packageName', 'hours', 'editedImages'],
  elopement: ['packageName', 'hours', 'editedImages'],
  portrait:  ['packageName', 'sessionMinutes', 'editedImages', 'locations', 'outfitChanges']
};

export function requiredSpecsFor(templateKey) {
  // hasOwnProperty, so 'constructor' is not a template.
  if (!Object.prototype.hasOwnProperty.call(SPECS, templateKey)) return [];
  return SPECS[templateKey].slice();
}

export const MAX_PACKAGE_LABEL = 200;
export const MAX_SPEC_VALUE = 120;

export function validatePackage(pkg) {
  const errors = [];
  const d = pkg && typeof pkg === 'object' ? pkg : {};

  const label = typeof d.label === 'string' ? d.label.trim() : '';
  if (!label) errors.push('A package needs a name.');
  else if (label.length > MAX_PACKAGE_LABEL) errors.push('That package name is too long.');

  const key = typeof d.templateKey === 'string' ? d.templateKey : '';
  if (TEMPLATE_KEYS.indexOf(key) === -1) {
    errors.push('Pick which contract this package uses: ' + TEMPLATE_KEYS.join(', ') + '.');
  }

  if (!Number.isInteger(d.priceCents) || d.priceCents <= 0) {
    errors.push('The price must be a whole number of cents above zero.');
  }

  const specs = d.specs && typeof d.specs === 'object' ? d.specs : null;
  if (!specs) {
    errors.push('This package is missing its contract details.');
  } else {
    // Every required spec must be present and non-empty. A missing one becomes a
    // blank in a contract someone signs, so it is refused here rather than at send.
    for (const name of requiredSpecsFor(key)) {
      const v = specs[name];
      const s = v === undefined || v === null ? '' : String(v).trim();
      if (!s) errors.push('Missing contract detail: ' + name + '.');
      else if (s.length > MAX_SPEC_VALUE) errors.push('That value is too long: ' + name + '.');
    }
    // A spec the chosen template has no place for is a sign the wrong template was
    // picked — a portrait's outfitChanges on a wedding contract has nowhere to go.
    const allowed = requiredSpecsFor(key);
    for (const name of Object.keys(specs)) {
      if (allowed.indexOf(name) === -1) {
        errors.push('That detail does not belong on this contract: ' + name + '.');
      }
    }
  }

  return { ok: errors.length === 0, errors: errors };
}
