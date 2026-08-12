const MAX = { name: 200, partnerName: 200, email: 320, phone: 50, eventDate: 40, sessionType: 200, message: 5000 };

// Shown to real visitors on a wedding photographer's contact form, so these
// read as words rather than field names.
const LABEL = {
  name: 'name',
  partnerName: "partner's name",
  email: 'email',
  phone: 'phone number',
  eventDate: 'date',
  sessionType: 'session type',
  message: 'message'
};

// Returns a trimmed string, or null if the value is not a usable scalar.
// Deliberately does NOT call String() on objects or arrays: payloads arrive
// as parsed JSON, and String() on a deeply nested array overflows the stack.
function str(v) {
  if (v === undefined || v === null) return '';
  const t = typeof v;
  if (t === 'string') return v.trim();
  if (t === 'number' || t === 'boolean') return String(v).trim();
  return null;
}

export function validateInquiry(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, error: 'That submission did not look right. Please try again.' };
  }

  const value = {};
  for (const key of Object.keys(MAX)) {
    const s = str(data[key]);
    if (s === null) {
      return { valid: false, error: 'That ' + LABEL[key] + ' did not look right. Please try again.' };
    }
    value[key] = s;
  }

  for (const key of Object.keys(MAX)) {
    if (value[key].length > MAX[key]) {
      return { valid: false, error: 'That ' + LABEL[key] + ' is too long.' };
    }
  }

  if (!value.name) return { valid: false, error: 'Please add your name.' };
  if (!value.email) return { valid: false, error: 'Please add your email.' };
  // Deliberately permissive: one @, no spaces, a dot in the domain.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) {
    return { valid: false, error: 'That email address does not look right.' };
  }
  if (!value.phone) return { valid: false, error: 'Please add your phone number.' };

  return { valid: true, value: value };
}
