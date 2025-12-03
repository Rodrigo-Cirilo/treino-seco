#include <12F675.h>
#fuses INTRC_IO, NOWDT, NOMCLR, NOPROTECT, NOCPD
#use delay(clock=4000000)   // Interno 4MHz

void main() {
   set_tris_a(0b00000001);  // A0 = entrada, resto saída
   output_low(PIN_A5);      // Garante A5 desligado

   while(true) {

      // Se entrada A0 está em nível alto
      if (input(PIN_A0)) {

         // Pulso de 75ms em A5
         output_high(PIN_A5);
         delay_ms(75);
         output_low(PIN_A5);

         // Debounce de 500ms
         delay_ms(500);
      }
   }
}

