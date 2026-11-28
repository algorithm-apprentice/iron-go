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
    string: "rgb(206, 145, 120)", escape: "rgb(215, 186, 125)", number: "rgb(181, 206, 168)",
    comment: "rgb(106, 153, 85)", documentation: "rgb(106, 153, 85)", hex: "rgb(181, 206, 168)", identifier: "rgb(204, 204, 204)" },
  light: { declaration: "rgb(0, 0, 255)", flow: "rgb(175, 0, 219)", type: "rgb(38, 127, 153)",
    string: "rgb(163, 21, 21)", escape: "rgb(238, 0, 0)", number: "rgb(9, 134, 88)",
    comment: "rgb(0, 128, 0)", documentation: "rgb(0, 128, 0)", hex: "rgb(9, 134, 88)", identifier: "rgb(59, 59, 59)" },
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
