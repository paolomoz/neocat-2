export default function decorate(block) {
  // Add wrapper class for background styling
  const wrapper = block.closest('.product-cards-wrapper');
  if (wrapper) {
    wrapper.style.backgroundColor = '#f0e8f0';
  }

  // Iterate through each row (card)
  [...block.children].forEach((row) => {
    const cells = [...row.children];
    
    // Add card class to row
    row.classList.add('card');
    
    // Process each cell
    if (cells[0]) {
      cells[0].classList.add('card-image');
    }
    
    if (cells[1]) {
      cells[1].classList.add('card-title');
    }
    
    if (cells[2]) {
      cells[2].classList.add('card-description');
    }
    
    if (cells[3]) {
      cells[3].classList.add('card-link');
    }
  });
}