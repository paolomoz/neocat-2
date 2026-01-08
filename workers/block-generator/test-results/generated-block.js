export default function decorate(block) {
  const rows = [...block.children];
  if (rows.length === 0) return;

  // Create carousel structure
  const wrapper = document.createElement('div');
  wrapper.className = 'carousel-7-slides-wrapper';

  const track = document.createElement('div');
  track.className = 'carousel-7-slides-track';

  // Process each row as a slide
  rows.forEach((row, index) => {
    row.classList.add('carousel-7-slides-slide');
    if (index === 0) row.classList.add('active');

    const cells = [...row.children];
    if (cells[0]) cells[0].classList.add('carousel-7-slides-image');
    if (cells[1]) cells[1].classList.add('carousel-7-slides-content');

    track.appendChild(row);
  });

  wrapper.appendChild(track);

  // Navigation buttons
  const prevBtn = document.createElement('button');
  prevBtn.className = 'carousel-7-slides-nav carousel-7-slides-nav--prev';
  prevBtn.setAttribute('aria-label', 'Previous slide');
  prevBtn.innerHTML = '❮';

  const nextBtn = document.createElement('button');
  nextBtn.className = 'carousel-7-slides-nav carousel-7-slides-nav--next';
  nextBtn.setAttribute('aria-label', 'Next slide');
  nextBtn.innerHTML = '❯';

  // Dots navigation
  const dots = document.createElement('div');
  dots.className = 'carousel-7-slides-dots';
  rows.forEach((_, index) => {
    const dot = document.createElement('button');
    dot.className = 'carousel-7-slides-dot' + (index === 0 ? ' active' : '');
    dot.setAttribute('aria-label', `Go to slide ${index + 1}`);
    dot.dataset.slide = index.toString();
    dots.appendChild(dot);
  });

  // Append all elements
  block.innerHTML = '';
  block.appendChild(wrapper);
  block.appendChild(prevBtn);
  block.appendChild(nextBtn);
  block.appendChild(dots);

  // State
  let currentSlide = 0;
  const totalSlides = rows.length;

  function goToSlide(index) {
    if (index < 0) index = totalSlides - 1;
    if (index >= totalSlides) index = 0;
    currentSlide = index;

    track.style.transform = `translateX(-${currentSlide * 100}%)`;

    // Update active states
    track.querySelectorAll('.carousel-7-slides-slide').forEach((slide, i) => {
      slide.classList.toggle('active', i === currentSlide);
    });
    dots.querySelectorAll('.carousel-7-slides-dot').forEach((dot, i) => {
      dot.classList.toggle('active', i === currentSlide);
    });
  }

  // Event listeners
  prevBtn.addEventListener('click', () => goToSlide(currentSlide - 1));
  nextBtn.addEventListener('click', () => goToSlide(currentSlide + 1));
  dots.addEventListener('click', (e) => {
    const dot = e.target.closest('.carousel-7-slides-dot');
    if (dot) goToSlide(parseInt(dot.dataset.slide, 10));
  });

  // Auto-advance (optional)
  // setInterval(() => goToSlide(currentSlide + 1), 5000);
}
