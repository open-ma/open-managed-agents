export interface Skill {
  id: string;
  name: string;
  system_prompt_addition: string;
  tools?: Record<string, unknown>;
}

const skillRegistry = new Map<string, Skill>();

export function registerSkill(skill: Skill) {
  skillRegistry.set(skill.id, skill);
}

export function resolveSkills(skillConfigs: Array<{ skill_id: string }>): Skill[] {
  return skillConfigs.map(s => skillRegistry.get(s.skill_id)).filter(Boolean) as Skill[];
}

// Register built-in skills
registerSkill({
  id: "web_research",
  name: "Web Research",
  system_prompt_addition: "You have web research capabilities. Use web_search to find information and web_fetch to read web pages. Always cite your sources.",
});

registerSkill({
  id: "code_review",
  name: "Code Review",
  system_prompt_addition: "You are an expert code reviewer. Focus on: correctness, security vulnerabilities, performance issues, code style, and maintainability. Provide specific line-level feedback.",
});

registerSkill({
  id: "data_analysis",
  name: "Data Analysis",
  system_prompt_addition: "You are a data analyst. Use Python with pandas, numpy, and matplotlib for analysis. Always show your methodology, visualize results, and explain findings clearly.",
});

registerSkill({
  id: "xlsx_processing",
  name: "Excel Processing",
  system_prompt_addition: "You can process Excel (.xlsx) files. Use Python with openpyxl to read, analyze, and create spreadsheets.",
});

registerSkill({
  id: "pptx_processing",
  name: "PowerPoint Processing",
  system_prompt_addition: "You can process PowerPoint (.pptx) files. Use Python with python-pptx to read, analyze, and create presentations.",
});

registerSkill({
  id: "pdf_processing",
  name: "PDF Processing",
  system_prompt_addition: "You can process PDF files. Use Python with PyPDF2 or pdfplumber to read, extract text, and analyze PDFs.",
});

registerSkill({
  id: "docx_processing",
  name: "Document Processing",
  system_prompt_addition: "You can process Word (.docx) files. Use Python with python-docx to read, analyze, and create documents.",
});
