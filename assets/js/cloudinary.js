// assets/js/cloudinary.js
export const CLOUDINARY = {
  cloudName: "dpj33zjpk",
  uploadPreset: "album-mana",
  folder: "album-mana",
};

function uploadWithProgress(file, resourceType, onProgress) {
  const url = `https://api.cloudinary.com/v1_1/${CLOUDINARY.cloudName}/${resourceType}/upload`;
  const form = new FormData();
  form.append("file", file);
  form.append("upload_preset", CLOUDINARY.uploadPreset);
  form.append("folder", CLOUDINARY.folder);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);

    xhr.upload.onprogress = (evt) => {
      if (!evt.lengthComputable) return;
      const ratio = evt.total ? (evt.loaded / evt.total) : 0;
      if (typeof onProgress === "function") onProgress(ratio);
    };

    xhr.onerror = () => reject(new Error("Erreur réseau pendant l'upload"));
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(xhr.responseText || `Upload échoué (${xhr.status})`));
        return;
      }
      try {
        resolve(JSON.parse(xhr.responseText));
      } catch (e) {
        reject(new Error("Réponse Cloudinary invalide"));
      }
    };

    xhr.send(form);
  });
}

// Signature compatible avec ton code existant : uploadImage(file) marche toujours.
// Tu peux aussi faire uploadImage(file, { onProgress: (p)=>... })
export function uploadImage(file, { onProgress } = {}) {
  return uploadWithProgress(file, "image", onProgress);
}

export function uploadVideo(file, { onProgress } = {}) {
  return uploadWithProgress(file, "video", onProgress);
}
