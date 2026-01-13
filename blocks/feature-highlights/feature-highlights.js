export default function decorate(block) {
  const rows = Array.from(block.children);
  
  rows.forEach((row) => {
    row.classList.add('feature-item');
    
    const cells = Array.from(row.children);
    
    if (cells.length >= 2) {
      cells[0].classList.add('feature-icon');
      cells[1].classList.add('feature-label');
    }
    
    const img = row.querySelector('img');
    if (img) {
      img.loading = 'lazy';
    }
  });
}