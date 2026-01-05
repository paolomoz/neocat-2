export default function decorate(block) {
  const rows = [...block.children];
  
  // Create wrapper for the section title
  const sectionTitleWrapper = document.createElement('div');
  sectionTitleWrapper.className = 'section-title-wrapper';
  
  // First row contains the section title in cell 0
  if (rows[0]) {
    const firstRowCells = [...rows[0].children];
    if (firstRowCells[0] && firstRowCells[0].textContent.trim() === 'Book it your way') {
      const sectionTitle = document.createElement('h2');
      sectionTitle.className = 'section-title';
      sectionTitle.textContent = firstRowCells[0].textContent.trim();
      block.insertBefore(sectionTitle, block.firstChild);
    }
  }
  
  // Process each row as a card
  rows.forEach((row, index) => {
    const cells = [...row.children];
    row.classList.add('card');
    
    // cell 0: section title (only for first card, already extracted)
    // cell 1: card heading
    // cell 2: card description
    // cell 3: card CTA
    
    if (cells[0]) {
      // First cell might be section title or empty
      if (index === 0 && cells[0].textContent.trim() === 'Book it your way') {
        cells[0].style.display = 'none';
      }
    }
    
    if (cells[1]) {
      cells[1].classList.add('card-heading');
      const headingText = cells[1].textContent.trim();
      cells[1].innerHTML = `<h3>${headingText}</h3>`;
    }
    
    if (cells[2]) {
      cells[2].classList.add('card-description');
    }
    
    if (cells[3]) {
      cells[3].classList.add('card-cta');
    }
  });
}