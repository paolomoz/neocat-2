export default function decorate(block) {
  // Auto-generated test block
  const rows = [...block.children];
  rows.forEach((row) => {
    row.classList.add("test-generated-row");
  });
  console.log("Test block decorated!");
}