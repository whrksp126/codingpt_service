// src/pages/Curriculum.jsx
import Header from '../components/curriculum/Header';
import Main from '../components/curriculum/Main';
import { curriculumList } from '../assets/lesson_dummy/curriculumList';

const Curriculum = () => {
  const searchParams = new URLSearchParams(window.location.search);
  const curriculum_id = searchParams.get('curriculum_id');
  const section_id = searchParams.get('section_id');
  const curriculum = curriculumList.find((curriculum) => curriculum.id === Number(curriculum_id));
  const section = curriculum.sections.find((section)=> section.id === Number(section_id));
  

  return (
    <div 
      className="
        flex flex-col items-center justify-center
        mx-auto
      "
    >
      <Header/>
      <Main section={section} />
    </div>
    
  );
};

export default Curriculum;
