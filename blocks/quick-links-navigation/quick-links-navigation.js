export default function decorate(block) {
  const rows = Array.from(block.children);
  block.innerHTML = '';
  
  rows.forEach((row) => {
    const cells = Array.from(row.children);
    const linkItem = document.createElement('div');
    linkItem.className = 'quick-link-item';
    
    // First cell contains the icon
    if (cells[0]) {
      const iconWrapper = document.createElement('div');
      iconWrapper.className = 'quick-link-icon';
      const img = cells[0].querySelector('img');
      if (img) {
        iconWrapper.appendChild(img.cloneNode(true));
      }
      linkItem.appendChild(iconWrapper);
    }
    
    // Second cell contains the link text
    if (cells[1]) {
      const textWrapper = document.createElement('div');
      textWrapper.className = 'quick-link-text';
      const link = cells[1].querySelector('a');
      if (link) {
        textWrapper.appendChild(link.cloneNode(true));
      } else {
        textWrapper.innerHTML = cells[1].innerHTML;
      }
      linkItem.appendChild(textWrapper);
    }
    
    block.appendChild(linkItem);
  });
}