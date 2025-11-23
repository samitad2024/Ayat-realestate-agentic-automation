import React, { useEffect, useRef } from 'react';

interface LiveVisualizerProps {
  analyser: AnalyserNode | null;
  isListening: boolean;
  isSpeaking: boolean;
}

const LiveVisualizer: React.FC<LiveVisualizerProps> = ({ analyser, isListening, isSpeaking }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const render = () => {
      // Handle canvas resizing
      if (canvas.width !== canvas.offsetWidth || canvas.height !== canvas.offsetHeight) {
        canvas.width = canvas.offsetWidth;
        canvas.height = canvas.offsetHeight;
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      if (!analyser) {
        // Idle state animation
        drawIdleState(ctx, canvas.width, canvas.height);
        animationRef.current = requestAnimationFrame(render);
        return;
      }

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      analyser.getByteTimeDomainData(dataArray);

      ctx.lineWidth = 3;
      // Determine color based on state
      if (isSpeaking) {
        ctx.strokeStyle = '#10B981'; // Green for AI speaking
      } else if (isListening) {
        ctx.strokeStyle = '#3B82F6'; // Blue for User speaking
      } else {
        ctx.strokeStyle = '#94A3B8'; // Grey for idle connected
      }

      ctx.beginPath();
      const sliceWidth = canvas.width / bufferLength;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * canvas.height) / 2;

        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }

        x += sliceWidth;
      }

      ctx.lineTo(canvas.width, canvas.height / 2);
      ctx.stroke();

      animationRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [analyser, isListening, isSpeaking]);

  const drawIdleState = (ctx: CanvasRenderingContext2D, width: number, height: number) => {
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 1;
    ctx.stroke();
  };

  return <canvas ref={canvasRef} className="w-full h-full rounded-lg" />;
};

export default LiveVisualizer;
