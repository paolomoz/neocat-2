export default function decorate(block) {
  const rows = [...block.children];
  
  // First row is background image, second is content
  if (rows.length >= 2) {
    const bgRow = rows[0];
    const contentRow = rows[1];
    
    bgRow.classList.add("hero-gradient-bg");
    contentRow.classList.add("hero-gradient-content");
    
    // Add fade-in animation
    contentRow.style.opacity = "0";
    setTimeout(() => {
      contentRow.style.transition = "opacity 0.5s ease-in";
      contentRow.style.opacity = "1";
    }, 100);
  }
}