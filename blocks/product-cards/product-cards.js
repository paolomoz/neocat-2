export default function decorate(block) {
  // Add wrapper for background styling
  const wrapper = block.closest('.product-cards-wrapper');
  if (wrapper) {
    wrapper.style.backgroundColor = '#e8e4f0';
  }

  // Process each row as a card
  [...block.children].forEach((row) => {
    const cells = [...row.children];
    
    row.classList.add('card');
    
    // Cell 0: Image
    if (cells[0]) {
      cells[0].classList.add('card-image');
    }
    
    // Cell 1: Title
    if (cells[1]) {
      cells[1].classList.add('card-title');
    }
    
    // Cell 2: Description
    if (cells[2]) {
      cells[2].classList.add('card-description');
    }
    
    // Cell 3: Link/CTA
    if (cells[3]) {
      cells[3].classList.add('card-link');
    }
  });
}