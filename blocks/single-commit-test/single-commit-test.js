export default function decorate(block) {
  // This block was created in a single commit!
  block.classList.add("decorated");
  console.log("Single commit test block");
}