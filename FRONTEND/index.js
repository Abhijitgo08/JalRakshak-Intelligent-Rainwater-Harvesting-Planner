// index.js

document.addEventListener("DOMContentLoaded", () => {
  console.log("Index page loaded ");

  // Smooth scroll for navbar links
  document.querySelectorAll("nav a[href^='#']").forEach(anchor => {
    anchor.addEventListener("click", function (e) {
      e.preventDefault();
      document.querySelector(this.getAttribute("href")).scrollIntoView({
        behavior: "smooth"
      });
    });
  });

  // Button: Start Now → go to auth.html
  const startBtn = document.querySelector("a[href='auth.html']");
  if (startBtn) {
    startBtn.addEventListener("click", () => {
      console.log("Navigating to Auth page...");
    });
  }
});
