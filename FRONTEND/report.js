// report.js

document.addEventListener("DOMContentLoaded", () => {
  // Example data 
  const reportData = {
    userName: "Rahul Sharma",
    userLocation: "Pune, India",
    annualSave: 200000,
    familyCoverage: 6,
    cityHouseholds: 30,
    roofArea: 120,
    roofType: "Concrete Flat",
    runoffCoeff: 0.85,
    rainfall: 720,
    aquiferType: "Unconfined",
    gwDepth: 15,
    pitDims: "2 × 2 × 3",
    tankCapacity: 5655
  };

  // Fill report with data
  for (const key in reportData) {
    const el = document.getElementById(key);
    if (el) el.textContent = reportData[key];
  }

  // PDF download
  document.getElementById("downloadReport").addEventListener("click", () => {
    const element = document.querySelector("main");
    const opt = {
      margin: 0.5,
      filename: "JalRakshak_Report.pdf",
      image: { type: "jpeg", quality: 0.98 },
      html2canvas: { scale: 2 },
      jsPDF: { unit: "in", format: "a4", orientation: "portrait" }
    };
    html2pdf().set(opt).from(element).save();
  });
});
