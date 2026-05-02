// DOM이 로드된 후 실행
document.addEventListener('DOMContentLoaded', function() {
    console.log('페이지가 로드되었습니다!');

    // 1. 클릭 버튼 이벤트
    const clickBtn = document.getElementById('clickBtn');
    const result = document.getElementById('result');
    let clickCount = 0;

    clickBtn.addEventListener('click', function() {
        clickCount++;
        const messages = [
            '안녕하세요! 👋',
            '좋은 하루 되세요! ☀️',
            '코딩 재밌네요! 💻',
            '계속 클릭해보세요! 🎯',
            '멋져요! 🚀'
        ];
        const randomMessage = messages[Math.floor(Math.random() * messages.length)];
        result.textContent = `${randomMessage} (클릭 횟수: ${clickCount})`;
        
        // 애니메이션 효과
        result.style.transform = 'scale(1.1)';
        setTimeout(() => {
            result.style.transform = 'scale(1)';
        }, 200);
    });

    // 2. 카운터 기능
    const counter = document.getElementById('counter');
    const incrementBtn = document.getElementById('incrementBtn');
    const decrementBtn = document.getElementById('decrementBtn');
    let count = 0;

    incrementBtn.addEventListener('click', function() {
        count++;
        updateCounter();
    });

    decrementBtn.addEventListener('click', function() {
        count--;
        updateCounter();
    });

    function updateCounter() {
        counter.textContent = count;
        
        // 색상 변경 효과
        if (count > 0) {
            counter.style.color = '#4caf50';
        } else if (count < 0) {
            counter.style.color = '#f44336';
        } else {
            counter.style.color = '#667eea';
        }

        // 애니메이션
        counter.style.transform = 'scale(1.2)';
        setTimeout(() => {
            counter.style.transform = 'scale(1)';
        }, 200);
    }

    // 3. 색상 변경 기능
    const colorBox = document.getElementById('colorBox');
    const changeColorBtn = document.getElementById('changeColorBtn');
    
    const colors = [
        'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
        'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
        'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
        'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
        'linear-gradient(135deg, #30cfd0 0%, #330867 100%)',
        'linear-gradient(135deg, #a8edea 0%, #fed6e3 100%)',
        'linear-gradient(135deg, #ff9a9e 0%, #fecfef 100%)'
    ];
    let colorIndex = 0;

    changeColorBtn.addEventListener('click', function() {
        colorIndex = (colorIndex + 1) % colors.length;
        colorBox.style.background = colors[colorIndex];
        
        // 회전 애니메이션
        colorBox.style.transform = 'rotate(5deg)';
        setTimeout(() => {
            colorBox.style.transform = 'rotate(0deg)';
        }, 300);
    });

    // 4. 시간 표시 기능
    const timeDisplay = document.getElementById('timeDisplay');
    
    function updateTime() {
        const now = new Date();
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        const date = now.toLocaleDateString('ko-KR', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            weekday: 'long'
        });
        
        timeDisplay.innerHTML = `
            <div style="font-size: 1.2rem; margin-bottom: 10px; opacity: 0.8;">${date}</div>
            <div style="font-size: 2.5rem;">${hours}:${minutes}:${seconds}</div>
        `;
    }

    // 초기 시간 표시
    updateTime();
    
    // 1초마다 시간 업데이트
    setInterval(updateTime, 1000);

    // 5. 카드 호버 효과 강화
    const cards = document.querySelectorAll('.card');
    cards.forEach(card => {
        card.addEventListener('mouseenter', function() {
            this.style.transform = 'translateY(-5px) scale(1.02)';
        });
        
        card.addEventListener('mouseleave', function() {
            this.style.transform = 'translateY(0) scale(1)';
        });
    });

    // 콘솔에 환영 메시지
    console.log('%c🎉 샘플 페이지가 성공적으로 로드되었습니다!', 'color: #667eea; font-size: 16px; font-weight: bold;');
    console.log('이 페이지는 HTML, CSS, JavaScript로 구성되어 있습니다.');
});

