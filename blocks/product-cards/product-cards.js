export default function decorate(block) {
  const rows = [...block.children];
  
  // Clear the block
  block.innerHTML = '';
  
  // Add wrapper class for background
  block.parentElement?.classList.add('product-cards-wrapper');
  
  // Group rows into cards (4 rows per card: image, title, description, link)
  const cardsData = [];
  let currentCard = {};
  
  rows.forEach((row) => {
    const cells = [...row.children];
    if (cells.length >= 2) {
      const type = cells[0].textContent.trim().toLowerCase();
      const content = cells[1];
      
      if (type === 'image') {
        if (currentCard.image) {
          cardsData.push(currentCard);
          currentCard = {};
        }
        currentCard.image = content.querySelector('img');
      } else if (type === 'title') {
        currentCard.title = content.textContent.trim();
      } else if (type === 'description') {
        currentCard.description = content.textContent.trim();
      } else if (type === 'link') {
        currentCard.link = content.querySelector('a');
        cardsData.push(currentCard);
        currentCard = {};
      }
    }
  });
  
  // Create card elements
  cardsData.forEach((cardData) => {
    const card = document.createElement('div');
    card.className = 'card';
    
    // Image container
    const imageContainer = document.createElement('div');
    imageContainer.className = 'card-image';
    if (cardData.image) {
      const img = cardData.image.cloneNode(true);
      imageContainer.appendChild(img);
    }
    card.appendChild(imageContainer);
    
    // Title
    const title = document.createElement('h2');
    title.className = 'card-title';
    title.textContent = cardData.title || '';
    card.appendChild(title);
    
    // Description
    const description = document.createElement('p');
    description.className = 'card-description';
    description.textContent = cardData.description || '';
    card.appendChild(description);
    
    // Link
    const linkContainer = document.createElement('div');
    linkContainer.className = 'card-link';
    if (cardData.link) {
      const link = cardData.link.cloneNode(true);
      linkContainer.appendChild(link);
    }
    card.appendChild(linkContainer);
    
    block.appendChild(card);
  });
}