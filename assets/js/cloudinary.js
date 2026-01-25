// assets/js/cloudinary.js
export const CLOUDINARY = {
  cloudName: "dpj33zjpk",      // ex: "dxxxxx"
  uploadPreset: "album-mana",   // ton preset Unsigned
  folder: "album-mana",
};

async function upload(file, resourceType) {
  const url = `https://api.cloudinary.com/v1_1/${CLOUDINARY.cloudName}/${resourceType}/upload`;
  const form = new FormData();
  form.append("file", file);
  form.append("upload_preset", CLOUDINARY.uploadPreset);
  form.append("folder", CLOUDINARY.folder);

  const res = await fetch(url, { method: "POST", body: form });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function uploadImage(file) {
  return upload(file, "image");
}

export async function uploadVideo(file) {
  return upload(file, "video");
}
