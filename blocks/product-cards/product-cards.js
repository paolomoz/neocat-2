export default function decorate(block) {
  const rows = [...block.children];
  
  // Clear the block
  block.innerHTML = '';
  
  // First row is the section heading
  if (rows.length > 0) {
    const headingRow = rows[0];
    const headingText = headingRow.textContent.trim();
    const sectionHeading = document.createElement('h2');
    sectionHeading.className = 'section-heading';
    sectionHeading.textContent = headingText;
    block.appendChild(sectionHeading);
  }
  
  // Create cards container
  const cardsContainer = document.createElement('div');
  cardsContainer.className = 'cards-container';
  
  // Process remaining rows as cards
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const cells = [...row.children];
    
    const card = document.createElement('div');
    card.className = 'card';
    
    // Cell 0: Image
    if (cells[0]) {
      const img = cells[0].querySelector('img');
      if (img) {
        img.className = 'card-image';
        card.appendChild(img);
      }
    }
    
    // Cell 1: Title
    if (cells[1]) {
      const title = document.createElement('h3');
      title.className = 'card-title';
      title.textContent = cells[1].textContent.trim();
      card.appendChild(title);
    }
    
    // Cell 2: Description
    if (cells[2]) {
      const description = document.createElement('p');
      description.className = 'card-description';
      description.textContent = cells[2].textContent.trim();
      card.appendChild(description);
    }
    
    // Cell 3: CTA
    if (cells[3]) {
      const ctaContainer = document.createElement('div');
      ctaContainer.className = 'card-cta';
      const link = cells[3].querySelector('a');
      if (link) {
        ctaContainer.appendChild(link.cloneNode(true));
      }
      card.appendChild(ctaContainer);
    }
    
    cardsContainer.appendChild(card);
  }
  
  block.appendChild(cardsContainer);
}