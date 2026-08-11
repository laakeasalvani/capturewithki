const MAX = { name: 200, partnerName: 200, email: 320, phone: 50, eventDate: 40, sessionType: 200, message: 5000 };

function str(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

export function validateInquiry(data) {
  const d = data || {};
  const value = {
    name: str(d.name),
    partnerName: str(d.partnerName),
    email: str(d.email),
    phone: str(d.phone),
    eventDate: str(d.eventDate),
    sessionType: str(d.sessionType),
    message: str(d.message)
  };

  for (const key of Object.keys(MAX)) {
    if (value[key].length > MAX[key]) {
      return { valid: false, error: 'That ' + key + ' is too long.' };
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
