export const goSyntaxSample = `package main

// Readable comment.
/** Documented comment. */
var seed = 0x2a
func paint(x int) string {
	if x > 17 && true {
		return "glow\\n"
	}
	return ""
}
`;

export const expectedGoSyntax = {
  dark: { declaration: "rgb(86, 156, 214)", flow: "rgb(197, 134, 192)", type: "rgb(78, 201, 176)",
    string: "rgb(214, 160, 133)", escape: "rgb(215, 186, 125)", number: "rgb(181, 206, 168)",
    comment: "rgb(122, 159, 107)", documentation: "rgb(122, 159, 107)", hex: "rgb(181, 206, 168)", identifier: "rgb(204, 204, 204)" },
  light: { declaration: "rgb(36, 93, 168)", flow: "rgb(134, 45, 148)", type: "rgb(8, 117, 105)",
    string: "rgb(162, 60, 43)", escape: "rgb(139, 78, 23)", number: "rgb(23, 107, 68)",
    comment: "rgb(52, 116, 79)", documentation: "rgb(52, 116, 79)", hex: "rgb(23, 107, 68)", identifier: "rgb(59, 59, 59)" },
};

export function renderedGoSyntax() {
  const tokens = [...document.querySelectorAll("#editor .view-lines .view-line span[class*='mtk']")]
    .map(element => ({ text: element.textContent.replaceAll("\u00a0", " ").trim(), color: getComputedStyle(element).color }));
  const color = text => tokens.find(token => token.text === text)?.color ?? null;
  return {
    declaration: color("func"), flow: color("if"), type: color("int"),
    string: tokens.find(token => token.text.startsWith('"glow'))?.color ?? null,
    escape: color("\\n"), number: color("17"), comment: color("// Readable comment."), identifier: color("paint"),
    documentation: tokens.find(token => token.text.includes("Documented comment."))?.color ?? null,
    hex: color("0x2a"),
  };
}
