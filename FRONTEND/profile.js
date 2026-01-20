document.addEventListener("DOMContentLoaded", () => {
  const profileName = document.getElementById("profileName");
  const form = document.getElementById("profileForm");
  const logoutBtn = document.getElementById("logoutBtn");

  // Load user data from localStorage (simulate DB)
  const userData = JSON.parse(localStorage.getItem("userData")) || {
    name: "User",
    location: "",
    taluka: "",
    district: ""
  };

  // Pre-fill profile page
  document.getElementById("nameInput").value = userData.name;
  document.getElementById("locationInput").value = userData.location;
  document.getElementById("talukaInput").value = userData.taluka;
  document.getElementById("districtInput").value = userData.district;
  profileName.textContent = userData.name;

  // Save changes
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const updatedUser = {
      name: document.getElementById("nameInput").value,
      location: document.getElementById("locationInput").value,
      taluka: document.getElementById("talukaInput").value,
      district: document.getElementById("districtInput").value
    };
    localStorage.setItem("userData", JSON.stringify(updatedUser));
    profileName.textContent = updatedUser.name;
    alert("Profile updated successfully!");
  });

  // Logout
  logoutBtn.addEventListener("click", () => {
    localStorage.clear();
    window.location.href = "index.html"; 
  });
});
