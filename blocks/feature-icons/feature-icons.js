export default function decorate(block) {
  const rows = Array.from(block.children);
  block.innerHTML = '';
  
  rows.forEach((row) => {
    const cells = Array.from(row.children);
    const featureItem = document.createElement('div');
    featureItem.className = 'feature-item';
    
    // First cell contains the icon
    if (cells[0]) {
      const iconWrapper = document.createElement('div');
      iconWrapper.className = 'feature-icon';
      const img = cells[0].querySelector('img');
      if (img) {
        iconWrapper.appendChild(img.cloneNode(true));
      }
      featureItem.appendChild(iconWrapper);
    }
    
    // Second cell contains the label text
    if (cells[1]) {
      const labelWrapper = document.createElement('div');
      labelWrapper.className = 'feature-label';
      labelWrapper.textContent = cells[1].textContent.trim();
      featureItem.appendChild(labelWrapper);
    }
    
    block.appendChild(featureItem);
  });
}