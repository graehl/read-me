// Owner token: a random secret this browser keeps in local storage and sends with each upload,
// so it can later list and download its own takes. Clearing site data loses access to them.

export const OWNER_HEADER = "X-Read-Me-Owner";
const STORAGE_KEY = "read-me.owner-token";

/** This browser's owner token, created on first use. */
export function ownerToken() {
  let token = localStorage.getItem(STORAGE_KEY);
  if (!token) {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(STORAGE_KEY, token);
  }
  return token;
}

/** The token if this browser has uploaded before; null otherwise, without creating one. */
export function existingOwnerToken() {
  return localStorage.getItem(STORAGE_KEY);
}
