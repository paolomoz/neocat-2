export default function decorate(block) {
  const rows = [...block.children];
  
  rows.forEach((row) => {
    const cells = [...row.children];
    
    if (cells.length >= 4) {
      // First cell is image
      const imageCell = cells[0];
      imageCell.className = 'card-image';
      
      // Second cell is heading
      const headingCell = cells[1];
      headingCell.className = 'card-heading';
      
      // Third cell is body text
      const bodyCell = cells[2];
      bodyCell.className = 'card-body';
      
      // Fourth cell is CTA
      const ctaCell = cells[3];
      ctaCell.className = 'card-cta';
    }
  });
}