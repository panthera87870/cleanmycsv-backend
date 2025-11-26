export function maskEmail(email) {
  if (!email.includes("@")) return email;
  const [name, domain] = email.split("@");
  return name[0] + "***@" + domain;
}

export function maskPhone(phone) {
  return phone.replace(/\d(?=\d{2})/g, "*"); // garde 2 derniers chiffres
}
