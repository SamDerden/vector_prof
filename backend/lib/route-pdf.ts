import fs from "node:fs/promises";
import path from "node:path";
import { PDFDocument, rgb, PDFString } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
export type PdfLine={text:string;url?:string};
export async function renderRoutePdf(lines:PdfLine[]) {
 const doc=await PDFDocument.create(); doc.registerFontkit(fontkit);
 const font=await doc.embedFont(await fs.readFile(path.join(process.cwd(),'data/fonts/DejaVuSans.ttf')),{subset:true});
 doc.setTitle('Вектор — индивидуальный маршрут'); doc.setLanguage('ru-RU');
 let page=doc.addPage([595.28,841.89]), y=790;
 const supported=new Set(font.getCharacterSet());
 for(const item of lines){
  const text=Array.from(item.text.replace(/[\r\n\t]+/g,' ')).map(c=>supported.has(c.codePointAt(0)!)?c:'?').join('');
  let line='';
  const draw=()=>{
   if(y<55){page=doc.addPage([595.28,841.89]);y=790;}
   page.drawText(line,{x:45,y,size:11,font,color:rgb(0.1,0.15,0.2)});
   if(item.url && /^https?:\/\//i.test(item.url)){
    const annotation=doc.context.obj({Type:'Annot',Subtype:'Link',Rect:[45,y-3,Math.min(550,45+font.widthOfTextAtSize(line,11)),y+13],Border:[0,0,0],A:{Type:'Action',S:'URI',URI:PDFString.of(item.url)}});
    page.node.addAnnot(doc.context.register(annotation));
   }
   y-=17;line='';
  };
  // Character wrapping also handles unbroken URLs without horizontal overflow.
  for(const c of text){if(font.widthOfTextAtSize(line+c,11)>505)draw();line+=c;}
  if(line)draw(); y-=8;
 }
 for(const [index,p] of doc.getPages().entries())p.drawText(String(index+1),{x:290,y:25,font,size:9});
 return doc.save();
}
