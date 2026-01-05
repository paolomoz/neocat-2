export default function decorate(block) {
  const cards = [...block.children];
  
  cards.forEach((card) => {
    card.classList.add('card');
    
    const children = [...card.children];
    
    if (children[0]) {
      children[0].classList.add('card-image-wrapper');
      const img = children[0].querySelector('img');
      if (img) {
        img.classList.add('card-image');
      }
    }
    
    if (children[1]) {
      const headingText = children[1].textContent;
      children[1].innerHTML = `<h2 class="card-heading">${headingText}</h2>`;
    }
    
    if (children[2]) {
      children[2].classList.add('card-description');
    }
    
    if (children[3]) {
      children[3].classList.add('card-cta');
    }
  });
}