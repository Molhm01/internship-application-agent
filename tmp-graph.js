const g = require("./graphify-out/graph.json");

console.log("=== Graph Statistics ===");
console.log(`Total nodes: ${g.node_count}`);
console.log(`Node types in data:`, Object.keys(g.data || {}).slice(0, 5).join(", "));
console.log(`Labels available:`, Object.keys(g.labels || {}));
console.log("");

// Extract API patterns from edge labels and node tags if they exist
const apiRelated = g.nodes?.filter((n) => n.tags && (n.tags.includes("api") || n.type === "endpoint")) || [];
if(apiRelated.length > 0){ console.log("API endpoints:", JSON.stringify(Object.fromEntries(new Map(apiRelated.map(n=>[Object.keys(n)[0], Object.values(n)[0].map(e=>String(e.target||e)).join("/")])))); });

// Check for auth patterns in labels
const authLabel = g.labels?.auth || "not explicitly labeled";
console.log("Auth pattern:", JSON.stringify(authLabel).replace(/"/g, "'"));
