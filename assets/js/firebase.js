// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyDHnzmQvbNVObRH8YI8nayAXLPvxqPiAqw",
  authDomain: "album-mana.firebaseapp.com",
  projectId: "album-mana",
  storageBucket: "album-mana.firebasestorage.app",
  messagingSenderId: "1029814542522",
  appId: "1:1029814542522:web:8474784c3dc774ac4a6283",
  measurementId: "G-Z544K88S23"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);