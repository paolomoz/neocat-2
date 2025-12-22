export default function decorate(block) {
  const row = block.querySelector(':scope > div');
  if (row) {
    row.classList.add('feature-highlights-grid');
    
    const cells = row.querySelectorAll(':scope > div');
    cells.forEach((cell) => {
      cell.classList.add('feature-item');
      
      const img = cell.querySelector('img');
      if (img) {
        img.classList.add('feature-icon');
      }
      
      const p = cell.querySelector('p');
      if (p) {
        p.classList.add('feature-label');
      }
    });
  }
}