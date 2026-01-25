// assets/js/cloudinary.js
export const CLOUDINARY = {
  cloudName: "dpj33zjpk",
  uploadPreset: "album-mana",
  folder: "album-mana",
};

function xhrUpload(file, resourceType, onProgress) {
  return new Promise((resolve, reject) => {
    const url = `https://api.cloudinary.com/v1_1/${CLOUDINARY.cloudName}/${resourceType}/upload`;
    const form = new FormData();
    form.append("file", file);
    form.append("upload_preset", CLOUDINARY.uploadPreset);
    form.append("folder", CLOUDINARY.folder);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);

    xhr.upload.onprogress = (e) => {
      if (!onProgress) return;
      if (!e.lengthComputable) return onProgress(null);
      onProgress(Math.round((e.loaded / e.total) * 100));
    };

    xhr.onerror = () => reject(new Error("Erreur réseau Cloudinary"));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { reject(new Error("Réponse Cloudinary invalide")); }
      } else {
        reject(new Error(xhr.responseText || `Cloudinary ${xhr.status}`));
      }
    };

    xhr.send(form);
  });
}

// Thumbs
export function imageThumbUrl(publicId) {
  // carré doux, qualité auto
  return `https://res.cloudinary.com/${CLOUDINARY.cloudName}/image/upload/c_fill,w_900,h_900,q_auto,f_auto/${publicId}.jpg`;
}

export function videoThumbUrl(publicId) {
  // image à 0s (so_0), format jpg
  return `https://res.cloudinary.com/${CLOUDINARY.cloudName}/video/upload/so_0,c_fill,w_900,h_600,q_auto,f_jpg/${publicId}.jpg`;
}

export async function uploadImage(file, onProgress) {
  return xhrUpload(file, "image", onProgress);
}

export async function uploadVideo(file, onProgress) {
  return xhrUpload(file, "video", onProgress);
}
