// contact.js
document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("contactForm");
  const responseBox = document.getElementById("formResponse");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const formData = new FormData(form);

    try {
      const res = await fetch("https://formspree.io/f/xzzjbpbo", {
        method: "POST",
        body: formData,
        headers: { Accept: "application/json" },
      });

      if (res.ok) {
        responseBox.textContent = " Thank you! Your enquiry has been sent successfully.";
        responseBox.className = "mt-6 text-center text-lg font-semibold text-green-700";
        form.reset();
      } else {
        responseBox.textContent = " Failed to send message. Please try again later.";
        responseBox.className = "mt-6 text-center text-lg font-semibold text-red-600";
      }
    } catch (err) {
      console.error("Form submission error:", err);
      responseBox.textContent = " Error: Could not connect to server.";
      responseBox.className = "mt-6 text-center text-lg font-semibold text-red-600";
    }

    responseBox.classList.remove("hidden");
  });
});
